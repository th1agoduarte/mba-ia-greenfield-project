import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NonRetryableProcessingError } from '../media/media.errors';
import { MediaProbeService } from '../media/media-probe.service';
import type {
  DeliveryContext,
  ProcessingOutcome,
  VideoUploadedMessage,
} from '../messaging/messaging.types';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { videoThumbnailKey } from './videos.constants';

/** Thumbnail frame position: 10% of the duration (TD-06 Revision). */
const THUMBNAIL_POSITION = 0.1;

/**
 * Worker side of the pipeline: metadata + thumbnail, then the final status
 * (phase-03-videos/TD-06, TD-09). Runs in the background, so errors are
 * turned into outcomes for the consumer instead of being re-thrown.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaProbe: MediaProbeService,
  ) {}

  async handle(
    message: VideoUploadedMessage,
    context: DeliveryContext,
  ): Promise<ProcessingOutcome> {
    const video = await this.videoRepository.findOneBy({
      id: message.video_id,
    });
    // Duplicate or stale delivery: only `processing` videos are worked on.
    if (!video || video.status !== VideoStatus.PROCESSING) {
      return 'ok';
    }

    try {
      await this.process(video);
      return 'ok';
    } catch (err) {
      const error = err as Error;
      const terminal =
        error instanceof NonRetryableProcessingError || context.isLastAttempt;
      this.logger.warn(
        `Video ${video.id} attempt ${context.attempt} failed${terminal ? ' (final)' : ''}: ${error.message}`,
      );
      if (!terminal) {
        return 'retry';
      }
      await this.markFailed(video.id, error.message);
      return 'fail';
    }
  }

  private async process(video: Video): Promise<void> {
    const source = await this.storageService.presignGetObject(
      video.storage_key,
      { internal: true },
    );
    const { duration_seconds, metadata } = await this.mediaProbe.probe(source);
    const frame = await this.mediaProbe.extractFrame(
      source,
      duration_seconds * THUMBNAIL_POSITION,
    );
    const thumbnailKey = videoThumbnailKey(video.id);
    await this.storageService.putObject(thumbnailKey, frame, 'image/jpeg');

    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds,
        metadata,
        thumbnail_key: thumbnailKey,
        processing_error: null,
      },
    );
  }

  private async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, processing_error: reason.slice(0, 2000) },
    );
  }
}
