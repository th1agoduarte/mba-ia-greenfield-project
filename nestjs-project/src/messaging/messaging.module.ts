import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { AmqpConnectionManager } from 'amqp-connection-manager';
import { amqpConnectionProvider } from './amqp-connection.provider';
import { AMQP_CONNECTION } from './messaging.constants';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessingPublisher } from './video-processing.publisher';

@Module({
  providers: [
    amqpConnectionProvider,
    VideoProcessingPublisher,
    VideoProcessingConsumer,
  ],
  exports: [VideoProcessingPublisher, VideoProcessingConsumer],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(
    @Inject(AMQP_CONNECTION)
    private readonly connection: AmqpConnectionManager,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}
