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
