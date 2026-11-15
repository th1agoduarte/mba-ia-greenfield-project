import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { MediaModule } from '../media/media.module';
import { MessagingModule } from '../messaging/messaging.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';
import { VideoWorker } from './video-worker';

/** Worker feature: consumes the queue and processes videos (TD-05, TD-06). */
@Module({
  imports: [
    // Video → Channel → User relations must be known to the metadata builder.
    TypeOrmModule.forFeature([Video, Channel, User]),
    MessagingModule,
    StorageModule,
    MediaModule,
  ],
  providers: [VideoProcessingService, VideoWorker],
})
export class VideoProcessingModule {}
