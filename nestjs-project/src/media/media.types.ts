import type { VideoMetadata } from '../videos/entities/video.entity';

export interface ProbeResult {
  duration_seconds: number | null;
  metadata: VideoMetadata;
}
