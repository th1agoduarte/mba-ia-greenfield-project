import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import messagingConfig from '../config/messaging.config';
import {
  deleteQueueNamespace,
  drainQueue,
  useIsolatedQueueNamespaceForTests,
  waitFor,
} from '../test/messaging';
import { videoProcessingTopology } from './messaging.constants';
import { MessagingModule } from './messaging.module';
import type {
  DeliveryContext,
  ProcessingOutcome,
  VideoUploadedMessage,
} from './messaging.types';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessingPublisher } from './video-processing.publisher';

type Delivery = { message: VideoUploadedMessage; context: DeliveryContext };

async function buildModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [messagingConfig] }),
      MessagingModule,
    ],
  }).compile();
}

describe('Video processing messaging (integration — RabbitMQ)', () => {
  let namespace: string;
  let module: TestingModule;
  let publisher: VideoProcessingPublisher;
  let consumer: VideoProcessingConsumer;
  let deliveries: Delivery[];
  let nextOutcome: ProcessingOutcome;

  beforeEach(async () => {
    namespace = useIsolatedQueueNamespaceForTests('messaging');
    module = await buildModule();
    publisher = module.get(VideoProcessingPublisher);
    consumer = module.get(VideoProcessingConsumer);
    deliveries = [];
    nextOutcome = 'ok';
    await consumer.start((message, context) => {
      deliveries.push({ message, context });
      return Promise.resolve(nextOutcome);
    });
  });

  afterEach(async () => {
    await module.close();
    await deleteQueueNamespace(namespace);
  });

  it('delivers a published video.uploaded message with attempt 1', async () => {
    const videoId = randomUUID();

    await publisher.publishVideoUploaded(videoId);

    await waitFor(() => Promise.resolve(deliveries.length === 1));
    expect(deliveries[0].message).toEqual({ video_id: videoId });
    expect(deliveries[0].context).toEqual({ attempt: 1, isLastAttempt: false });
  });

  it('redelivers a retried message after the TTL with x-attempt incremented, then parks it after 3 attempts', async () => {
    nextOutcome = 'retry';
    const videoId = randomUUID();

    await publisher.publishVideoUploaded(videoId);

    await waitFor(() => Promise.resolve(deliveries.length === 3));
    expect(deliveries.map((d) => d.context.attempt)).toEqual([1, 2, 3]);
    expect(deliveries[2].context.isLastAttempt).toBe(true);

    const { deadQueue } = videoProcessingTopology(namespace);
    const parked = await waitFor(async () => {
      const msgs = await drainQueue(deadQueue);
      return msgs.length ? msgs : null;
    });
    expect(parked).toHaveLength(1);
    expect(parked[0].body).toEqual({ video_id: videoId });
    expect(parked[0].headers['x-attempt']).toBe(3);

    await new Promise((r) => setTimeout(r, 500));
    expect(deliveries).toHaveLength(3);
  });

  it('parks a failed message immediately without retrying', async () => {
    nextOutcome = 'fail';

    await publisher.publishVideoUploaded(randomUUID());

    const { deadQueue } = videoProcessingTopology(namespace);
    const parked = await waitFor(async () => {
      const msgs = await drainQueue(deadQueue);
      return msgs.length ? msgs : null;
    });
    expect(parked[0].headers['x-attempt']).toBe(1);
    expect(deliveries).toHaveLength(1);
  });

  it('does not deliver messages from another namespace', async () => {
    const otherNamespace = useIsolatedQueueNamespaceForTests('other');
    const otherModule = await buildModule();
    try {
      await otherModule
        .get(VideoProcessingPublisher)
        .publishVideoUploaded(randomUUID());

      await new Promise((r) => setTimeout(r, 500));
      expect(deliveries).toHaveLength(0);
      const { queue } = videoProcessingTopology(otherNamespace);
      expect(await drainQueue(queue)).toHaveLength(1);
    } finally {
      await otherModule.close();
      await deleteQueueNamespace(otherNamespace);
    }
  });
});
