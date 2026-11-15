import type { ConfirmChannel } from 'amqplib';
import {
  VIDEO_UPLOADED_ROUTING_KEY,
  type VideoProcessingTopology,
} from './messaging.constants';

/**
 * Idempotent declaration of the video processing topology (TD-12):
 * main queue, TTL retry queue dead-lettering back to the exchange, and a
 * parking queue for messages that exhausted their attempts.
 */
export async function assertVideoProcessingTopology(
  channel: ConfirmChannel,
  names: VideoProcessingTopology,
  retryDelayMs: number,
): Promise<void> {
  await channel.assertExchange(names.exchange, 'direct', { durable: true });
  await channel.assertQueue(names.queue, { durable: true });
  await channel.bindQueue(
    names.queue,
    names.exchange,
    VIDEO_UPLOADED_ROUTING_KEY,
  );
  await channel.assertQueue(names.retryQueue, {
    durable: true,
    messageTtl: retryDelayMs,
    deadLetterExchange: names.exchange,
    deadLetterRoutingKey: VIDEO_UPLOADED_ROUTING_KEY,
  });
  await channel.assertQueue(names.deadQueue, { durable: true });
}
