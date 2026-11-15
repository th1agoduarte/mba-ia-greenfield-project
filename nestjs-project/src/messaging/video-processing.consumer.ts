import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type {
  ChannelWrapper,
  AmqpConnectionManager,
} from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import messagingConfig from '../config/messaging.config';
import {
  AMQP_CONNECTION,
  ATTEMPT_HEADER,
  PUBLISH_TIMEOUT_MS,
  videoProcessingTopology,
} from './messaging.constants';
import type {
  ProcessingOutcome,
  VideoUploadedHandler,
  VideoUploadedMessage,
} from './messaging.types';
import { assertVideoProcessingTopology } from './topology';

/**
 * Consumes `video.uploaded` one message at a time (prefetch 1) and applies the
 * retry policy of TD-12: `retry` → TTL retry queue with `x-attempt + 1` until
 * `maxAttempts`, then the dead queue; `fail` → dead queue. The original
 * delivery is acked only after the follow-up publish is confirmed.
 */
@Injectable()
export class VideoProcessingConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(VideoProcessingConsumer.name);
  private readonly names: ReturnType<typeof videoProcessingTopology>;
  private channel: ChannelWrapper | null = null;

  constructor(
    @Inject(AMQP_CONNECTION)
    private readonly connection: AmqpConnectionManager,
    @Inject(messagingConfig.KEY)
    private readonly config: ConfigType<typeof messagingConfig>,
  ) {
    this.names = videoProcessingTopology(config.namespace);
  }

  async start(handler: VideoUploadedHandler): Promise<void> {
    const channel = this.connection.createChannel({
      name: 'video-processing-consumer',
      json: true,
      setup: (ch: ConfirmChannel) =>
        assertVideoProcessingTopology(ch, this.names, this.config.retryDelayMs),
    });
    this.channel = channel;
    await channel.waitForConnect();
    await channel.consume(
      this.names.queue,
      (msg) => {
        // Unacked on error: the broker redelivers it when the channel resets.
        this.onMessage(channel, msg, handler).catch((err: Error) =>
          this.logger.error(`Failed to settle message: ${err.message}`),
        );
      },
      { prefetch: 1 },
    );
    this.logger.log(`Consuming ${this.names.queue}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    this.channel = null;
  }

  private async onMessage(
    channel: ChannelWrapper,
    msg: ConsumeMessage,
    handler: VideoUploadedHandler,
  ): Promise<void> {
    const attempt = Number(msg.properties.headers?.[ATTEMPT_HEADER] ?? 1);
    const isLastAttempt = attempt >= this.config.maxAttempts;
    let outcome: ProcessingOutcome;
    let message: VideoUploadedMessage | null = null;
    try {
      message = JSON.parse(msg.content.toString()) as VideoUploadedMessage;
      outcome = await handler(message, { attempt, isLastAttempt });
    } catch (err) {
      this.logger.error(
        `Handler error on attempt ${attempt}: ${(err as Error).message}`,
      );
      outcome = message ? 'retry' : 'fail';
    }

    // The channel is in JSON mode: forward the parsed body, not the Buffer.
    const body = message ?? { raw: msg.content.toString() };
    if (outcome === 'retry' && !isLastAttempt) {
      await this.forward(channel, this.names.retryQueue, body, attempt + 1);
    } else if (outcome !== 'ok') {
      await this.forward(channel, this.names.deadQueue, body, attempt);
    }
    channel.ack(msg);
  }

  private async forward(
    channel: ChannelWrapper,
    queue: string,
    body: object,
    attempt: number,
  ): Promise<void> {
    await channel.sendToQueue(queue, body, {
      persistent: true,
      contentType: 'application/json',
      headers: { [ATTEMPT_HEADER]: attempt },
      timeout: PUBLISH_TIMEOUT_MS,
    });
  }
}
