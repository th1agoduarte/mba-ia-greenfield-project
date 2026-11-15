import { randomBytes, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidPartNumberException,
  UploadTooLargeException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { VideoProcessingPublisher } from '../messaging/video-processing.publisher';
import { StorageService } from '../storage/storage.service';
import type { CompletedPartInput } from '../storage/storage.types';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  InitiatedUploadDto,
  PartUrlsResponseDto,
  UploadedPartsResponseDto,
  VideoDetailsDto,
  VideoSummaryDto,
  toVideoDetails,
  toVideoSummary,
} from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  PG_UNIQUE_VIOLATION,
  VIDEO_SLUG,
  VIDEO_UPLOAD,
  videoOriginalKey,
} from './videos.constants';

function isSlugCollision(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as QueryFailedError & { code?: unknown; detail?: unknown };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes('(slug)')
  );
}

export const OVERSIZED_UPLOAD_ERROR = 'Uploaded file exceeds the 10 GiB limit';

export function generateVideoSlug(): string {
  return randomBytes(VIDEO_SLUG.RANDOM_BYTES).toString('base64url');
}

export function partCountFor(sizeBytes: number): number {
  return Math.ceil(sizeBytes / VIDEO_UPLOAD.PART_SIZE_BYTES);
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly publisher: VideoProcessingPublisher,
  ) {}

  /**
   * Pre-registers the video as `draft` and opens the S3 multipart upload
   * the client will fill directly (phase-03-videos/TD-02, TD-09).
   */
  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiatedUploadDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const id = randomUUID();
    const storageKey = videoOriginalKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    try {
      const video = await this.insertWithUniqueSlug({
        id,
        channel_id: channel.id,
        title: dto.title,
        status: VideoStatus.DRAFT,
        original_file_name: dto.file_name,
        content_type: dto.content_type,
        size_bytes: dto.file_size,
        storage_key: storageKey,
        upload_id: uploadId,
      });
      return {
        ...toVideoSummary(video),
        upload: {
          part_size: VIDEO_UPLOAD.PART_SIZE_BYTES,
          part_count: partCountFor(video.size_bytes),
          max_urls_per_request: VIDEO_UPLOAD.MAX_URLS_PER_REQUEST,
        },
      };
    } catch (err) {
      // Compensation: do not leave an orphan multipart upload behind.
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }
  }

  async presignParts(
    userId: string,
    slug: string,
    partNumbers: number[],
  ): Promise<PartUrlsResponseDto> {
    const video = await this.findOwnedDraft(userId, slug);
    const partCount = partCountFor(video.size_bytes);
    if (partNumbers.some((n) => n > partCount)) {
      throw new InvalidPartNumberException(partCount);
    }
    const urls = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          video.upload_id!,
          partNumber,
        ),
      })),
    );
    return { urls, expires_in: this.storageService.presignExpiresSeconds };
  }

  async listUploadedParts(
    userId: string,
    slug: string,
  ): Promise<UploadedPartsResponseDto> {
    const video = await this.findOwnedDraft(userId, slug);
    const parts = await this.storageService.listParts(
      video.storage_key,
      video.upload_id!,
    );
    return { parts };
  }

  /** Aborts the multipart upload and removes the draft. */
  async abortUpload(userId: string, slug: string): Promise<void> {
    const video = await this.findOwnedDraft(userId, slug);
    await this.storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id!,
    );
    await this.videoRepository.delete({ id: video.id });
  }

  /**
   * Closes the multipart upload, moves the video to `processing` and
   * publishes `video.uploaded` (TD-09, TD-12). Idempotent: a video already in
   * `processing` is returned as is, without a second message, and only the
   * call whose conditional update wins publishes. If publishing fails, the
   * status is compensated back to `draft` and the call can be retried.
   */
  async completeUpload(
    userId: string,
    slug: string,
    parts: CompletedPartInput[],
  ): Promise<VideoSummaryDto> {
    const video = await this.findOwnedOrFail(userId, slug);
    if (video.status === VideoStatus.PROCESSING) {
      return toVideoSummary(video);
    }
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoInvalidStateException(video.status);
    }

    // A previous attempt may have assembled the object before failing to
    // publish (its compensation clears upload_id).
    let head = await this.storageService.headObject(video.storage_key);
    if (!head && video.upload_id) {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id,
        parts,
      );
      head = await this.storageService.headObject(video.storage_key);
    }
    if (!head) {
      throw new VideoInvalidStateException(video.status);
    }

    // Part sizes are chosen by the client: enforce the 10 GiB cap on the result.
    if (head.contentLength > VIDEO_UPLOAD.MAX_SIZE_BYTES) {
      await this.videoRepository.update(
        { id: video.id, status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          upload_id: null,
          size_bytes: head.contentLength,
          processing_error: OVERSIZED_UPLOAD_ERROR,
        },
      );
      await this.storageService.deleteObject(video.storage_key);
      throw new UploadTooLargeException();
    }

    // Commit `processing` BEFORE publishing: the worker ignores videos that
    // are not in `processing`, so it must never see the message first.
    const { affected } = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.PROCESSING,
        upload_id: null,
        size_bytes: head.contentLength,
      },
    );
    if (!affected) {
      // A concurrent call moved it first and owns the publish.
      return toVideoSummary(await this.findOwnedOrFail(userId, slug));
    }
    try {
      await this.publisher.publishVideoUploaded(video.id);
    } catch (err) {
      // Compensation: back to draft so the client can retry the call. The
      // multipart upload is already completed, so upload_id stays null.
      await this.videoRepository.update(
        { id: video.id, status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
      throw err;
    }

    return { ...toVideoSummary(video), status: VideoStatus.PROCESSING };
  }

  async getVideo(userId: string, slug: string): Promise<VideoDetailsDto> {
    const video = await this.findOwnedOrFail(userId, slug);
    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.presignGetObject(video.thumbnail_key)
      : null;
    return toVideoDetails(video, thumbnailUrl);
  }

  /**
   * Presigned GET of the original: the storage serves Range requests with
   * 206, so playback starts without a full download (TD-08).
   */
  async getStreamUrl(userId: string, slug: string): Promise<string> {
    const video = await this.findOwnedReady(userId, slug);
    return this.storageService.presignGetObject(video.storage_key);
  }

  /** Same object, served as an attachment with the original file name. */
  async getDownloadUrl(userId: string, slug: string): Promise<string> {
    const video = await this.findOwnedReady(userId, slug);
    return this.storageService.presignGetObject(video.storage_key, {
      downloadFileName: video.original_file_name,
    });
  }

  /** Owner-only access: other users get VIDEO_NOT_FOUND (AMB-1). */
  async findOwnedOrFail(userId: string, slug: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async findOwnedReady(userId: string, slug: string): Promise<Video> {
    const video = await this.findOwnedOrFail(userId, slug);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async findOwnedDraft(userId: string, slug: string): Promise<Video> {
    const video = await this.findOwnedOrFail(userId, slug);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoInvalidStateException(video.status);
    }
    return video;
  }

  private async insertWithUniqueSlug(data: Partial<Video>): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({ ...data, slug: generateVideoSlug() }),
        );
      } catch (err) {
        if (!isSlugCollision(err) || attempt >= VIDEO_SLUG.MAX_ATTEMPTS) {
          throw err;
        }
      }
    }
  }
}
