---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1169.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-15T13:30:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1169.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-15T13:30:00-03:00"
  amqplib:
    version: "^2.3.1"
    context7_id: "/amqp-node/amqplib"
    fetched_at: "2026-11-15T13:30:00-03:00"
  amqp-connection-manager:
    version: "^4.1.15"
    context7_id: "— (not indexed by Context7; README from the npm registry)"
    fetched_at: "2026-11-15T13:30:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-15T14:31:12-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this phase (`phase-03-videos/TD-04`, `phase-03-videos/TD-11`) plus the infrastructure images pinned for TD-01/TD-03/TD-06. Pulled via Context7 on 2026-11-15. Re-fetch when the underlying TD changes.

Installed baseline in `nestjs-project/package-lock.json`: `@nestjs/common`/`@nestjs/core` 11.1.16, `typeorm` 0.3.28, `jest` 30.3.0, `typescript` 5.9.3. Runtime image `node:25.6.0-slim` (`Dockerfile.dev`).

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7, versions up to v3.1153) and `/websites/aws_amazon_s3` (multipart limits). Maps to `phase-03-videos/TD-03`, `TD-04`, `TD-02`, `TD-08`.

### Client for MinIO (S3-compatible)

```ts
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: 'us-east-1',               // any value; MinIO ignores it
  endpoint: 'http://minio:9000',     // Compose service name (never localhost)
  forcePathStyle: true,              // MinIO needs path-style: http://minio:9000/<bucket>/<key>
  credentials: { accessKeyId, secretAccessKey },
  // Recent SDK versions default to WHEN_SUPPORTED, which adds CRC32 checksum
  // headers/params to UploadPart/PutObject and x-amz-checksum-mode to GetObject.
  // For presigned URLs used by external clients this breaks the signature
  // unless the client sends the same checksum, so opt out:
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

Presigned URLs embed the host they were signed for. Use a **second client** whose `endpoint` is the public endpoint (`S3_PUBLIC_ENDPOINT`) for `getSignedUrl`, and the internal client for server-side calls (TD-03).

### Multipart upload (TD-02)

```ts
import {
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  ListPartsCommand, AbortMultipartUploadCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }));

// one presigned URL per part (client PUTs the raw bytes, reads the ETag response header)
const url = await getSignedUrl(publicS3, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });

// resume: parts already stored (max 1000 per page → paginate with PartNumberMarker)
const { Parts } = await s3.send(new ListPartsCommand({ Bucket, Key, UploadId }));

await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ ETag, PartNumber }, /* ascending */] },
}));
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
const head = await s3.send(new HeadObjectCommand({ Bucket, Key })); // head.ContentLength
```

Limits (Amazon S3 docs, MinIO follows them): up to **10,000 parts**, part numbers 1–10,000, part size **5 MiB–5 GiB** (last part may be smaller), single PUT max **5 GiB**, `ListParts` returns at most 1,000 parts per call. `CompleteMultipartUpload` fails with `InvalidPart`/`InvalidPartOrder` on wrong ETags/order and `NoSuchUpload` if the upload was completed/aborted.

### Presigned GET for stream/download (TD-08)

```ts
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
const streamUrl = await getSignedUrl(publicS3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
const downloadUrl = await getSignedUrl(publicS3, new GetObjectCommand({
  Bucket, Key, ResponseContentDisposition: `attachment; filename="${fileName}"`,
}), { expiresIn: 3600 });
await s3.send(new PutObjectCommand({ Bucket, Key: thumbKey, Body: jpegBuffer, ContentType: 'image/jpeg' }));
```

S3/MinIO answer `Range: bytes=a-b` on a presigned GET with `206 Partial Content` + `Content-Range`, which is what TD-08 relies on.

## amqplib

**Source:** `/amqp-node/amqplib` (Context7). Version 2.x ships its own TypeScript types (`index.d.ts`); no `@types/amqplib` needed. Maps to `phase-03-videos/TD-11`, `TD-12`.

```ts
await ch.assertExchange('videos', 'direct', { durable: true });
await ch.assertQueue('videos.processing', { durable: true });
await ch.bindQueue('videos.processing', 'videos', 'video.uploaded');
// retry queue: messages expire after the TTL and are dead-lettered back to the main exchange
await ch.assertQueue('videos.processing.retry', {
  durable: true, messageTtl: 5000,
  deadLetterExchange: 'videos', deadLetterRoutingKey: 'video.uploaded',
});
await ch.assertQueue('videos.processing.dead', { durable: true });
await ch.prefetch(1);
await ch.consume('videos.processing', async (msg) => { /* ... */ ch.ack(msg); }, { noAck: false });
ch.publish('videos', 'video.uploaded', Buffer.from(JSON.stringify(payload)), {
  persistent: true, contentType: 'application/json', headers: { 'x-attempt': 1 },
});
```

`assertQueue`/`assertExchange` are idempotent but reject with `406 PRECONDITION_FAILED` if an existing entity was declared with different arguments — names must not be reused with different options (e.g., changing `messageTtl` requires a new queue name or deleting the queue).

## amqp-connection-manager

**Source:** npm README of `amqp-connection-manager` (package not indexed by Context7 — discrepancy flagged per CLAUDE.md "Library Documentation Lookup"). Peer dependency `amqplib: *`; ships types (the connection type is exported as `AmqpConnectionManager`).

**Version note (TD-11 Revision, SI-03.4):** pinned to `^4.1.15`. Version 5.x depends on `promise-breaker@7`, which is ESM-only (`"type": "module"`); Node 25 loads it, but Jest's CommonJS runtime fails with `SyntaxError: Unexpected token 'export'`. The 4.x API used here (`connect`, `createChannel({ json, setup })`, `publish`/`sendToQueue` with `timeout`, `consume(queue, onMessage, { prefetch })`, `ack`, `waitForConnect`, `close`) is the same. With `json: true`, `publish`/`sendToQueue` JSON-encode the payload, so pass plain objects, never a `Buffer`.

```ts
import * as amqp from 'amqp-connection-manager';
const connection = amqp.connect(['amqp://user:pass@rabbitmq:5672']);
const channel = connection.createChannel({
  json: true,                 // publish() accepts plain objects
  setup: (ch: ConfirmChannel) => Promise.all([ /* assertExchange/assertQueue/bindQueue/prefetch/consume */ ]),
});
await channel.publish('videos', 'video.uploaded', payload, { persistent: true }); // resolves on broker confirm
channel.ack(msg); channel.nack(msg, false, false);
await channel.close(); await connection.close();
```

`setup` runs on every (re)connection, so topology declaration and `consume` belong there. `createChannel` defaults to a confirm channel; `publish` rejects if the broker refuses the message.

## Infrastructure images (pinned)

| Component | Image | Why |
|-----------|-------|-----|
| Object storage (TD-03) | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | Official `minio/minio` image no longer published on Docker Hub/Quay (checked 2026-11-15); `pgsty/minio` is a maintained MinIO build with dated release tags. User decision. |
| Bucket bootstrap (TD-03) | `pgsty/mc:RELEASE.2026-10-26T00-00-00Z` | MinIO client for the one-shot `mc mb --ignore-existing` service. |
| Message broker (TD-01) | `rabbitmq:4.2.9-management-alpine` | Official image, RabbitMQ 4.2 line with the management UI. |
| FFmpeg (TD-06) | Debian `ffmpeg` package installed in `Dockerfile.dev` (`node:25.6.0-slim`) | Provides `ffprobe` and `ffmpeg` binaries for the worker and for the tests in the same image (TD-05, TD-10). |
