/**
 * A processing failure that retrying cannot fix (not a video, missing
 * object): the worker marks the video `failed` at once (TD-06 Revision).
 */
export class NonRetryableProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableProcessingError';
  }
}
