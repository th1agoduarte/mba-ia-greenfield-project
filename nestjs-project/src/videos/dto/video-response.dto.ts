import type { Video } from '../entities/video.entity';
import { VideoStatus } from '../entities/video.entity';

export class UploadInstructionsDto {
  part_size: number;
  part_count: number;
  max_urls_per_request: number;
}

export class VideoSummaryDto {
  id: string;
  slug: string;
  title: string;
  status: VideoStatus;
}

export class InitiatedUploadDto extends VideoSummaryDto {
  upload: UploadInstructionsDto;
}

export class PartUrlDto {
  part_number: number;
  url: string;
}

export class PartUrlsResponseDto {
  urls: PartUrlDto[];
  expires_in: number;
}

export class UploadedPartDto {
  part_number: number;
  etag: string;
  size: number;
}

export class UploadedPartsResponseDto {
  parts: UploadedPartDto[];
}

export function toVideoSummary(video: Video): VideoSummaryDto {
  return {
    id: video.id,
    slug: video.slug,
    title: video.title,
    status: video.status,
  };
}

export class VideoMetadataDto {
  format_name: string | null;
  bit_rate: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  frame_rate: number | null;
}

export class VideoDetailsDto extends VideoSummaryDto {
  original_file_name: string;
  content_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  metadata: VideoMetadataDto | null;
  /** Presigned GET (1 h) of the generated thumbnail, once processed. */
  thumbnail_url: string | null;
  processing_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export function toVideoDetails(
  video: Video,
  thumbnailUrl: string | null,
): VideoDetailsDto {
  return {
    ...toVideoSummary(video),
    original_file_name: video.original_file_name,
    content_type: video.content_type,
    size_bytes: video.size_bytes,
    duration_seconds: video.duration_seconds,
    metadata: video.metadata,
    thumbnail_url: thumbnailUrl,
    processing_error: video.processing_error,
    created_at: video.created_at,
    updated_at: video.updated_at,
  };
}
