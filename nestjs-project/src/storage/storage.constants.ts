/** S3 error names returned by CompleteMultipartUpload for a bad part list. */
export const S3_INVALID_PARTS_ERRORS = [
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
] as const;

export const S3_NOT_FOUND_ERRORS = ['NotFound', 'NoSuchKey'] as const;

export const S3_NO_SUCH_UPLOAD_ERRORS = ['NoSuchUpload'] as const;
