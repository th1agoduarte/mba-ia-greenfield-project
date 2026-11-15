import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Entry point of the `video-worker` container: consumes `video.uploaded`,
 * runs ffprobe/ffmpeg and updates the video status (phase-03-videos/TD-05).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('Video worker started', 'VideoWorker');
}
void bootstrap();
