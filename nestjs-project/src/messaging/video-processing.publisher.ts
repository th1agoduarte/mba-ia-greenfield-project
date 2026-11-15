import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type {
  ChannelWrapper,
  AmqpConnectionManager,
} from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import messagingConfig from '../config/messaging.config';
import {
  AMQP_CONNECTION,
  ATTEMPT_HEADER,
  PUBLISH_TIMEOUT_MS,
  VIDEO_UPLOADED_ROUTING_KEY,
  videoProcessingTopology,
} from './messaging.constants';
import type { VideoUploadedMessage } from './messaging.types';
import { assertVideoProcessingTopology } from './topology';

/** Publishes `video.uploaded` with publisher confirms (Events/Messages). */
@Injectable()
export class VideoProcessingPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(VideoProcessingPublisher.name);
  private readonly names: ReturnType<typeof videoProcessingTopology>;
  private readonly channel: ChannelWrapper;

  constructor(
    @Inject(AMQP_CONNECTION) connection: AmqpConnectionManager,
    @Inject(messagingConfig.KEY)
    config: ConfigType<typeof messagingConfig>,
  ) {
    this.names = videoProcessingTopology(config.namespace);
    this.channel = connection.createChannel({
      name: 'video-processing-publisher',
      json: true,
      setup: (channel: ConfirmChannel) =>
        assertVideoProcessingTopology(channel, this.names, config.retryDelayMs),
    });
    // Setup errors (e.g. the app closing mid-connection) are emitted as events;
    // without a listener Node turns them into an uncaught exception.
    this.channel.on('error', (err: Error) =>
      this.logger.warn(`Publisher channel error: ${err.message}`),
    );
  }

  async publishVideoUploaded(videoId: string): Promise<void> {
    const message: VideoUploadedMessage = { video_id: videoId };
    await this.channel.publish(
      this.names.exchange,
      VIDEO_UPLOADED_ROUTING_KEY,
      message,
      {
        persistent: true,
        contentType: 'application/json',
        headers: { [ATTEMPT_HEADER]: 1 },
        timeout: PUBLISH_TIMEOUT_MS,
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel.close();
  }
}
