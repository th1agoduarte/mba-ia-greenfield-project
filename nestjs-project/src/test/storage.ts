/**
 * Presigned URLs are signed for S3_PUBLIC_ENDPOINT (the host the client
 * reaches, e.g. http://localhost:9000). Tests run inside the Compose network,
 * where only the internal endpoint resolves, so they sign for it instead.
 * Call before the config factories run (i.e. before compiling the module).
 */
export function useInternalStorageEndpointForTests(): void {
  process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
}
