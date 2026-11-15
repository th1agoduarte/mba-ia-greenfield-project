import { Module } from '@nestjs/common';
import { rootImports } from './config/root.imports';
import { VideoProcessingModule } from './videos/video-processing.module';

/** Root module of the video worker process — no HTTP layer (TD-05). */
@Module({
  imports: [...rootImports, VideoProcessingModule],
})
export class WorkerModule {}
