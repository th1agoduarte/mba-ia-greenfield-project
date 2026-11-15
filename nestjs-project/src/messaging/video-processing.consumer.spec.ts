import type { ConsumeMessage } from 'amqplib';
import type { ProcessingOutcome } from './messaging.types';
import { VideoProcessingConsumer } from './video-processing.consumer';

type OnMessage = (msg: ConsumeMessage) => void;

function fakeChannel() {
  let onMessage: OnMessage | undefined;
  return {
    on: jest.fn(),
    waitForConnect: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn((_q: string, cb: OnMessage) => {
      onMessage = cb;
      return Promise.resolve({ consumerTag: 't' });
    }),
    sendToQueue: jest.fn().mockResolvedValue(true),
    ack: jest.fn(),
    nack: jest.fn(),
    close: jest.fn(),
    deliver: (msg: ConsumeMessage) => onMessage!(msg),
  };
}

function message(headers: Record<string, unknown>): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify({ video_id: 'v1' })),
    properties: { headers },
  } as unknown as ConsumeMessage;
}

const flush = () => new Promise((r) => setImmediate(r));

describe('VideoProcessingConsumer', () => {
  let channel: ReturnType<typeof fakeChannel>;
  let consumer: VideoProcessingConsumer;
  let handler: jest.Mock<Promise<ProcessingOutcome>>;

  beforeEach(async () => {
    channel = fakeChannel();
    const connection = { createChannel: jest.fn(() => channel) };
    consumer = new VideoProcessingConsumer(connection as any, {
      url: 'amqp://x',
      namespace: 'ns',
      retryDelayMs: 5000,
      maxAttempts: 3,
    });
    handler = jest.fn();
    await consumer.start(handler);
  });

  it('treats a malformed x-attempt header as attempt 1', async () => {
    handler.mockResolvedValue('retry');

    channel.deliver(message({ 'x-attempt': 'abc' }));
    await flush();

    expect(handler).toHaveBeenCalledWith(
      { video_id: 'v1' },
      { attempt: 1, isLastAttempt: false },
    );
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      'ns.processing.retry',
      { video_id: 'v1' },
      expect.objectContaining({ headers: { 'x-attempt': 2 } }),
    );
    expect(channel.ack).toHaveBeenCalled();
  });

  it('parks the message on the last attempt', async () => {
    handler.mockResolvedValue('retry');

    channel.deliver(message({ 'x-attempt': 3 }));
    await flush();

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      'ns.processing.dead',
      { video_id: 'v1' },
      expect.anything(),
    );
    expect(channel.ack).toHaveBeenCalled();
  });

  it('requeues (nack) instead of leaving the delivery unsettled when forwarding fails', async () => {
    handler.mockResolvedValue('retry');
    channel.sendToQueue.mockRejectedValueOnce(new Error('confirm timeout'));

    channel.deliver(message({ 'x-attempt': 1 }));
    await flush();

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(channel.ack).not.toHaveBeenCalled();
  });
});
