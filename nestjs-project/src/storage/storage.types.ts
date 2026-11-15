export interface StoredPart {
  part_number: number;
  etag: string;
  size: number;
}

export interface CompletedPartInput {
  part_number: number;
  etag: string;
}

export interface ObjectHead {
  contentLength: number;
  contentType: string | null;
}

export interface PresignGetOptions {
  /** Sets `response-content-disposition: attachment; filename="..."`. */
  downloadFileName?: string;
  /** Sign for the internal endpoint (worker, inside the Compose network). */
  internal?: boolean;
}
