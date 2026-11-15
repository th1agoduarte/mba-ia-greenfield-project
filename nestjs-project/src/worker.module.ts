import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { rootImports } from './config/root.imports';
import { MediaModule } from './media/media.module';
import { MessagingModule } from './messaging/messaging.module';
import { StorageModule } from './storage/storage.module';
import { Channel } from './channels/entities/channel.entity';
import { User } from './users/entities/user.entity';
import { Video } from './videos/entities/video.entity';
import { VideoProcessingService } from './videos/video-processing.service';
import { VideoWorker } from './videos/video-worker';

/** Root module of the video worker process — no HTTP layer (TD-05). */
@Module({
  imports: [
    ...rootImports,
    // Video → Channel → User relations must be known to the metadata builder.
    TypeOrmModule.forFeature([Video, Channel, User]),
    MessagingModule,
    StorageModule,
    MediaModule,
  ],
  providers: [VideoProcessingService, VideoWorker],
})
export class WorkerModule {}
