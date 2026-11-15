import { registerAs } from '@nestjs/config';

export default registerAs('messaging', () => ({
  url: process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672',
  namespace: process.env.RABBITMQ_NAMESPACE || 'videos',
  retryDelayMs: parseInt(
    process.env.VIDEO_PROCESSING_RETRY_DELAY_MS || '5000',
    10,
  ),
  maxAttempts: parseInt(process.env.VIDEO_PROCESSING_MAX_ATTEMPTS || '3', 10),
}));
