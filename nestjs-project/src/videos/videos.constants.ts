/** Decided parameters of phase-03-videos/TD-02 (Revision 2026-11-15). */
export const VIDEO_UPLOAD = {
  MAX_SIZE_BYTES: 10 * 1024 ** 3,
  PART_SIZE_BYTES: 64 * 1024 ** 2,
  MAX_PARTS: 10_000,
  MAX_URLS_PER_REQUEST: 100,
} as const;

/** phase-03-videos/TD-07: 8 random bytes → 11 base64url characters. */
export const VIDEO_SLUG = {
  RANDOM_BYTES: 8,
  LENGTH: 11,
  MAX_ATTEMPTS: 5,
} as const;

export const PG_UNIQUE_VIOLATION = '23505';

export function videoOriginalKey(videoId: string): string {
  return `videos/${videoId}/original`;
}

export function videoThumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}
