import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import messagingConfig from '../config/messaging.config';
import { MessagingModule } from './messaging.module';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessingPublisher } from './video-processing.publisher';

describe('MessagingModule', () => {
  it('compiles and provides the publisher and the consumer', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [messagingConfig] }),
        MessagingModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingPublisher)).toBeDefined();
    expect(module.get(VideoProcessingConsumer)).toBeDefined();
    await module.close();
  });
});
