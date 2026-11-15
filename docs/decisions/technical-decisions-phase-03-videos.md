---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-15
scope_description: "Backend foundation for video upload and processing: message queue technology, 10 GB upload strategy, object storage layout and client, video worker runtime, metadata/thumbnail extraction, unique video URL, streaming/download delivery, status lifecycle with failure handling, and the test strategy for real storage/queue/worker."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the `videos` module (API), the video worker entry point, the `videos` table migration and the new Compose services (object storage, queue broker, worker). Every TD below is about this subproject.
- `next-frontend/` — No open decision in this document: the video UI is out of the scope of this phase (the challenge statement scopes Phase 03 to backend). TD-02 and TD-08 are `Cross-layer` because the contract they fix (direct-to-storage multipart handshake, redirect to a presigned URL) is the one the frontend will consume in Phase 05; they are decided once here.

_Research sources:_ Context7 (`/nestjs/docs.nestjs.com` queues recipe, `/taskforcesh/bullmq`, `/aws/aws-sdk-js-v3`, `/websites/aws_amazon_s3` multipart limits, `/timgit/pg-boss`, `/websites/ffmpeg_documentation`), npm registry metadata (2026-11-15) and Docker Hub / Quay image availability (2026-11-15).

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram (`docs/diagrams/software-arch.mermaid`) and `CLAUDE.md` list the Message Queue as `TBD`. The API publishes one job per uploaded video and the Video Worker consumes it. Video processing is slow (minutes for large files) and can fail transiently (storage/network hiccup), so the queue must give retries with backoff, a visible terminal-failure state, at-least-once delivery and a way to avoid duplicate jobs for the same video. It must run as a real service in `nestjs-project/compose.yaml`.

**Options:**

### Option A: BullMQ on Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed job queue. `@nestjs/bullmq` (official Nest package, `12.0.2`, peer `bullmq ^3–^6`, `@nestjs/common ^10–^12`) gives `BullModule.forRootAsync`, `registerQueue`, `@InjectQueue` and `@Processor` + `WorkerHost` classes.
- **Pros:** Official NestJS recipe (`docs.nestjs.com/techniques/queues`). Built-in `attempts` + `exponential` backoff, `failed`/`completed` states, `jobId` deduplication (one job per video), stalled-job recovery, concurrency per worker. The worker can be a separate process that only imports the processor module. Redis is a tiny, well-known container.
- **Cons:** New infrastructure (Redis) to operate. Redis persistence (AOF/RDB) must be enabled or queued jobs are lost on restart. Another connection config set (host/port) to keep consistent across schema, compose and `.env.example`.

### Option B: pg-boss on the existing PostgreSQL
- Job queue implemented on PostgreSQL tables (`SKIP LOCKED`). `pg-boss 12.x`; no official Nest module (manual provider or community wrapper).
- **Pros:** No new infrastructure — reuses the `db` service. Jobs are transactional with the app data (could enqueue in the same transaction that changes the video status). Retries, backoff and dead-letter supported.
- **Cons:** Polling-based; adds write load to the main DB, which also serves the API. No first-party Nest integration — module, lifecycle and shutdown hooks are hand-written. There would be no distinct "queue" container in the Compose stack, which is what the target architecture draws as a separate container.

### Option C: RabbitMQ (`amqplib` / `@golevelup/nestjs-rabbitmq`)
- AMQP broker. Retries via dead-letter exchanges + TTL queues; consumers ack/nack.
- **Pros:** Mature broker, language-agnostic consumers (a non-Node worker would still work). Good routing primitives if more event types appear later.
- **Cons:** Retry with backoff, deduplication and job state must be assembled by hand (DLX + TTL topology). Heavier container (Erlang VM, management UI). No official Nest module for AMQP job semantics — `@nestjs/microservices` RMQ transport is message-oriented, not job-oriented.

**Recommendation:** **Option A (BullMQ on Redis)** — it is the queue the NestJS docs document first-party, and it gives retries/backoff, terminal `failed` state and `jobId` dedup out of the box, which TD-09 depends on; Redis is a small, explicit queue container that matches the separate "Message Queue" box of the architecture diagram, while pg-boss would load the API's database and RabbitMQ would require hand-building the retry topology.

**Decision:** C (RabbitMQ) — chosen over the recommendation. Consequence for the rest of the phase: retries with backoff, terminal failure and duplicate-safe processing are not built in and must be specified (exchange/queue/dead-letter topology, retry policy, idempotent consumer) together with the Node client library.

---

## TD-02: Upload Strategy for Files up to 10 GB

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** The phase requires 10 GB uploads "sem impacto na performance", and the project plan's "Pontos de Atenção" adds that the upload must "permitir retomar em caso de falha de conexão". Amazon S3 (and MinIO, which implements the same API) caps a single `PUT` at **5 GiB**; multipart uploads accept 5 MiB–5 GiB parts (last part may be smaller), up to **10,000 parts** per object. The draft video record must be created when the upload starts. Cross-layer: the handshake sequence (initiate → upload parts → complete) is implemented by the API and executed by the client (frontend in a later phase, scripts/tests now).

**Options:**

### Option A: Direct-to-storage presigned multipart upload
- `POST /videos` creates the draft row and an S3 multipart upload (`CreateMultipartUpload`), returning the part size and part count. The client asks the API for presigned `UploadPart` URLs (batched), `PUT`s each part straight to the object storage and finally calls the API to `CompleteMultipartUpload` with the part ETags. Resume = `ListParts` and re-upload only the missing parts.
- **Pros:** File bytes never pass through the API — the Node event loop and API bandwidth are untouched regardless of file size. Native resumability (parts already stored survive a dropped connection). Parallel part uploads. Same code works against AWS S3 in production.
- **Cons:** More API surface (initiate, sign parts, list parts, complete, abort) and a multi-step client. Browser clients need CORS on the bucket exposing `ETag`. Abandoned uploads leave incomplete parts in the bucket until aborted (needs an abort endpoint and/or a bucket lifecycle rule).

### Option B: tus resumable protocol through the API (`@tus/server` + `@tus/s3-store`)
- The API mounts a tus endpoint; clients send the file in chunks with `PATCH` requests and the tus S3 store forwards them to S3 multipart.
- **Pros:** Standard resumable protocol with mature clients (`tus-js-client`, Uppy). Resume semantics fully specified by the protocol.
- **Cons:** Every byte of a 10 GB file still flows through the API process (streamed, but API bandwidth/CPU and request slots are consumed for the whole transfer), which is exactly what the phase wants to avoid. Mounting a non-Nest HTTP handler inside Nest (raw body, guards, exception filter) is extra integration work.

### Option C: Streaming `multipart/form-data` through the API to storage
- The API streams the request body (`busboy`) into `@aws-sdk/lib-storage` `Upload`, which performs multipart behind the scenes.
- **Pros:** Single HTTP request, simplest client.
- **Cons:** Bytes through the API (same bottleneck as B), no resume — a dropped connection at 9 GB restarts from zero, and long-lived requests are fragile behind proxies/timeouts.

**Recommendation:** **Option A (presigned multipart, direct to storage)** — it is the only option where a 10 GB transfer has zero cost on the API and that is natively resumable, and the S3 limits (5 GiB single PUT, 10,000 parts) make multipart mandatory anyway; the extra endpoints are a fixed, testable contract. Suggested parameters: max size **10 GiB** (`10 × 1024³` bytes) validated at initiation; fixed part size chosen so that 10 GiB fits well under 10,000 parts (e.g., 64 MiB → 160 parts); presigned URLs short-lived (e.g., 1 h) and issued in batches.

**Decision:** A (Presigned multipart, direct to storage)

---

## TD-03: Object Storage Layout and Access Policy

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage technology is given (S3-compatible: MinIO locally, S3 in production). What is open is how to use it: buckets, key layout and how clients reach objects. This choice is cross-component: bucket name and endpoints live in the Joi schema, `compose.yaml` (bucket bootstrap), `.env.example` and the code that signs URLs. Presigned URLs embed the host they were signed for, so the endpoint the API uses internally (`http://minio:9000` on the Compose network) differs from the one a client outside Docker uses — the signing endpoint must be configurable. Note on the local image: the official `minio/minio` and `minio/mc` images are no longer available on Docker Hub or Quay (checked 2026-11-15); maintained builds exist (`pgsty/minio` with dated `RELEASE.*` tags, `cgr.dev/chainguard/minio`), to be pinned in `library-refs.md`.

**Options:**

### Option A: Single private bucket, per-video key prefix, access only via presigned URLs
- One bucket (e.g., `streamtube-videos`) with keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. No public policy; every read/write is a short-lived presigned URL issued by the API (upload parts, stream, download, thumbnail).
- **Pros:** One bucket to provision and configure (CORS, lifecycle). Everything for a video sits under one prefix (easy cleanup on delete in Phase 04). Private by default — draft/unlisted videos (Phases 04/05) are never publicly reachable. Keys derive from the immutable video id, never from user input.
- **Cons:** Thumbnails also need presigned URLs (no stable public URL → not CDN-cacheable as-is). Every client read goes through an API call first.

### Option B: Two buckets — private `videos`, public-read `thumbnails`
- Original files in a private bucket (presigned access); thumbnails in a bucket with an anonymous read policy and stable URLs.
- **Pros:** Thumbnails get stable, cacheable URLs (useful for the Phase 07 home grid). Clear separation by access level.
- **Cons:** Two buckets to provision and configure. Thumbnails of draft/unlisted videos become world-readable by key. Splits a video's assets across buckets.

### Option C: Public-read bucket for everything
- Objects readable by anyone who knows the key; API only signs uploads.
- **Pros:** Simplest delivery, stable URLs.
- **Cons:** Draft and unlisted videos are leakable; no way to restrict access later without migrating objects. Inadequate given Phase 04/05 visibility rules.

**Recommendation:** **Option A (single private bucket + presigned URLs)** — it keeps every asset private until the visibility rules of Phases 04/05 exist, and needs only one bucket to bootstrap; the API signs URLs with a configurable public endpoint (`S3_PUBLIC_ENDPOINT`) distinct from the internal one (`S3_ENDPOINT`), so presigned links work from the host and from inside the Compose network. The bucket is created idempotently at stack start-up by a one-shot Compose service. Stable public thumbnails can be revisited in Phase 07 with a Revision if a CDN is introduced.

**Decision:** A (Single private bucket + presigned URLs)

---

## TD-04: S3 Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The API (multipart initiation, part signing, completion, presigned GETs, `HeadObject`) and the worker (read the original, write the thumbnail) talk to S3-compatible storage. The library must support presigning `UploadPart` and `GetObject` (with `response-content-disposition`) and work with MinIO (`forcePathStyle`) and AWS S3 unchanged.

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Modular official SDK (`3.1169.0`). Commands (`CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `ListPartsCommand`, `GetObjectCommand`…) and `getSignedUrl` for presigning; `endpoint` + `forcePathStyle: true` for MinIO.
- **Pros:** First-party for the production target (S3); MinIO is tested against it. Full multipart and presign coverage, typed commands. Works for both API and worker.
- **Cons:** Verbose command-object API. Two packages; large dependency tree (tree-shaken per command).

### Option B: MinIO JavaScript client (`minio` 8.x)
- MinIO's own S3 client (`presignedPutObject`, `presignedGetObject`, `putObject`, `fPutObject`).
- **Pros:** Compact API. Works against S3 too.
- **Cons:** No public API to presign individual `UploadPart` requests — multipart is only done internally by `putObject`, which conflicts with TD-02 Option A. Last npm release in 2026-02; smaller ecosystem than the AWS SDK.

**Recommendation:** **Option A (AWS SDK v3)** — presigning `UploadPart` is required by the direct multipart strategy (TD-02 A) and only the AWS SDK exposes it, and it targets production S3 natively.

**Decision:** A (AWS SDK v3)

---

## TD-05: Video Worker Runtime

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture defines a separate "Video Worker (FFmpeg)" container that consumes jobs, reads/saves storage and updates the DB. It needs the `videos` entity, the DB/storage/queue configuration and `ffmpeg`/`ffprobe` binaries. It must start with `docker compose up` alongside the API.

**Options:**

### Option A: Same NestJS codebase, separate entry point and Compose service
- `nestjs-project/src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server) that imports the processor; a `video-worker` Compose service runs it from the same image (with `ffmpeg` installed) and the same source mount.
- **Pros:** Reuses entities, config namespaces, Joi validation, TypeORM data source and test helpers — no duplicated model. One dependency manifest, one lint/tsc/test pipeline (the Definition of Done covers the worker automatically). Scales independently (separate container/process).
- **Cons:** API and worker share one image, so the API image also carries `ffmpeg` (dev-only concern; can be split with a multi-stage build later). Module boundaries must keep HTTP-only providers out of the worker context.

### Option B: Separate subproject (`video-worker/` with its own `package.json`)
- An independent Node project with its own Dockerfile, consuming the queue and talking to DB/storage directly.
- **Pros:** Hard isolation; tiny image; could be rewritten in another language.
- **Cons:** Duplicates the `videos` entity/schema, config validation and test setup; a second toolchain outside the Definition of Done commands of `nestjs-project`; schema drift risk between two codebases.

### Option C: Processor inside the API process
- Register the `@Processor` in the API's `AppModule`; no extra container.
- **Pros:** Zero new runtime pieces.
- **Cons:** FFmpeg CPU/memory spikes run in the API process — contradicts "sem impacto na performance" and the separate Worker container of the architecture. Scaling processing means scaling the API.

**Recommendation:** **Option A (same codebase, separate entry point and container)** — it honors the separate Worker container of the architecture and keeps FFmpeg load out of the API, while reusing the entity, config and test infrastructure the project already has, so the worker is covered by the same `npm test` / `tsc` / `lint` gates.

**Decision:** A (Same codebase, separate entry point and container)

---

## TD-06: Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration and metadata (container, codecs, resolution, bitrate…) and render one frame as a thumbnail. Inputs can be 10 GB. The common Node wrapper `fluent-ffmpeg` is marked **deprecated** on npm ("Package no longer supported", repository archived in 2025). `ffprobe`/`ffmpeg` can read inputs over HTTP and seek with `Range` requests, so a presigned GET URL can be used as input without downloading the whole file.

**Options:**

### Option A: Spawn `ffprobe`/`ffmpeg` CLI directly, input = presigned GET URL
- `child_process.spawn('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', url])` for metadata; `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=… thumbnail.jpg` (input seeking) for the thumbnail, uploaded back with `PutObject`.
- **Pros:** No wrapper dependency (no deprecated lib). `ffprobe` JSON output is stable and fully typed by us. HTTP input + input seeking reads only the bytes needed (header/moov atom and around the chosen frame), so a 10 GB file is not copied to the worker's disk.
- **Cons:** We own argument building, exit-code/stderr handling and timeouts. MP4 files with the `moov` atom at the end need extra range reads (still far less than the full file).

### Option B: `fluent-ffmpeg` wrapper
- Fluent JS API over the same binaries (`ffprobe()`, `.screenshots()`).
- **Pros:** Less code; familiar API in tutorials.
- **Cons:** Deprecated/unsupported on npm — adopting it in a new phase contradicts the project rule of following current official docs. Types come from a separate `@types` package.

### Option C: Download the original to the worker's disk, then run ffprobe/ffmpeg on the local file
- Stream `GetObject` to a temp file, process locally, delete.
- **Pros:** Local file access is the most predictable for FFmpeg; no network seeks.
- **Cons:** Up to 10 GB of disk and transfer per job just to read a header and one frame; slower; requires disk sizing and cleanup on failure.

**Recommendation:** **Option A (direct CLI spawn reading a presigned URL)** — avoids a deprecated dependency and the 10 GB local copy; metadata and a single frame only need ranged reads. Suggested thumbnail frame: 10% of the duration (bounded to the video length), JPEG scaled to 1280 px wide; an input with no video stream fails processing (TD-09).

**Decision:** A (Spawn ffprobe/ffmpeg CLI reading a presigned URL)

---

## TD-07: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** "Pontos de Atenção" asks for "uma URL curta e única que nunca conflite com outro vídeo". The identifier is generated when the draft is created (TD-02) and used in every video route. The primary key convention of the project is `uuid` (`users`, `channels`).

**Options:**

### Option A: Random 11-char base64url slug (`crypto.randomBytes(8)`), unique index + retry
- 64 random bits encoded as base64url (YouTube-like length), stored in a `slug` column with a `UNIQUE` index; on the (astronomically rare) `23505` collision, regenerate and retry, the same pattern `ChannelsService` uses for nicknames.
- **Pros:** Short, URL-safe, non-sequential (no enumeration of other users' videos). No new dependency (`node:crypto`). Uniqueness guaranteed by the DB, not by probability.
- **Cons:** A second identifier besides the PK. Retry path needs a test with a forced collision.

### Option B: Use the UUID primary key in the URL
- `/videos/{uuid}`.
- **Pros:** Zero extra column or code; unique by construction.
- **Cons:** 36 characters — not "curta". Exposes the internal key.

### Option C: Sqids/Hashids encoding of a sequential integer
- Encode an auto-increment `bigint` into a short string.
- **Pros:** Short and collision-free by construction.
- **Cons:** Decodable → reveals creation order/volume; needs a `bigint` sequence in addition to the uuid PK and a new dependency (`sqids`); the "secret" alphabet becomes config that can never change.

**Recommendation:** **Option A (random base64url slug with DB uniqueness)** — short, non-enumerable and dependency-free, with uniqueness enforced by a `UNIQUE` index plus retry, reusing a pattern the codebase already has.

**Decision:** A (Random 11-char base64url slug + unique index + retry)

---

## TD-08: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, and the user must be able to download the original. The architecture diagram already draws "Frontend → Object Storage: Streams". S3/MinIO serve `Range` requests with `206 Partial Content` natively. Cross-layer: the frontend player (Phase 05) consumes whatever the API returns.

**Options:**

### Option A: API endpoint answers `302 Found` to a short-lived presigned GET URL
- `GET /videos/{slug}/stream` → 302 to a presigned `GetObject` URL (inline); `GET /videos/{slug}/download` → 302 to a presigned URL with `response-content-disposition=attachment; filename=…`. The player/browser then talks to storage directly with `Range` requests (206).
- **Pros:** Bytes never pass through the API (same principle as TD-02). Range/206, seeking and resume are implemented by the storage. Works with plain `<video src>`, `<a href>` and `curl -L`; authorization is checked by the API before the redirect.
- **Cons:** URL expiry must outlive a viewing session start (seeking after expiry fails until the player re-requests). Requires the public signing endpoint from TD-03.

### Option B: API endpoint returns JSON with the presigned URL
- `GET /videos/{slug}/playback` → `{ url, expires_at }`; the client sets it as the player source.
- **Pros:** Same storage-side delivery as A; expiry is explicit to the client.
- **Cons:** Two round trips for the client; not usable as a direct `<video src>` / download link; curl demos need two steps.

### Option C: API proxies byte ranges from storage (`206` built in Nest)
- The API parses `Range`, calls `GetObject` with that range and pipes the stream (`StreamableFile`) with `206`.
- **Pros:** Single origin; full control (auth per request, metrics).
- **Cons:** All playback traffic flows through the API — the bottleneck TD-02 avoids for uploads moves to playback; we re-implement Range parsing/validation.

### Option D: Adaptive streaming (HLS/DASH) generated by the worker
- Worker transcodes into segments + playlists; player uses HLS.
- **Pros:** Adaptive bitrate, the production-grade experience.
- **Cons:** Transcoding 10 GB inputs multiplies processing time and storage; the phase asks for streaming without full download, not adaptive bitrate. Disproportionate for this phase.

**Recommendation:** **Option A (302 redirect to a presigned URL)** — progressive streaming via HTTP Range is what the requirement asks for, storage already implements 206 correctly, and the API stays out of the data path while still authorizing each request; HLS can be a later Revision if adaptive bitrate becomes a requirement.

**Decision:** A (302 redirect to a presigned URL)

---

## TD-09: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The challenge fixes the lifecycle *rascunho → processando → pronto/erro*. Open: what triggers processing, how many states are persisted, how transient errors are retried and what a terminal failure looks like. Depends on TD-01 (retry/backoff primitives) and TD-02 (the "complete" step). Phase 04 adds a separate publication flow; the processing status must not be confused with it.

**Options:**

### Option A: Four persisted states, API-triggered processing, bounded retries then `failed`
- `draft` (row created at upload initiation) → `processing` (set by the API when `CompleteMultipartUpload` succeeds, in the same request that enqueues the job with `jobId = videoId`) → `ready` (worker saved metadata + thumbnail) or `failed` (worker exhausted the queue retries, e.g. 3 attempts with exponential backoff, or hit a non-retryable error such as "no video stream"; the error message is stored). The worker only acts on videos in `processing` and writes the final state once.
- **Pros:** Exactly the lifecycle the phase states; explicit trigger that works the same against S3 and MinIO; `jobId` dedup makes "complete" idempotent; failures are visible in the DB with a reason.
- **Cons:** If the enqueue fails after the status update, the API must surface the error and keep the request retryable (handled by idempotent "complete").

### Option B: Storage event notifications trigger processing
- MinIO/S3 bucket notifications (`s3:ObjectCreated:CompleteMultipartUpload`) publish to the queue; the API never enqueues.
- **Pros:** Processing starts even if the client never calls "complete" on the API.
- **Cons:** Notification setup differs between MinIO (Redis/webhook targets) and S3 (SNS/SQS/EventBridge) — not portable; event payload must be mapped back to a video; harder to test deterministically. The client still must complete the multipart upload, so the API call happens anyway.

### Option C: Status derived from the queue job (no persisted processing state)
- Store only `draft`/`ready` in the DB and read `processing`/`failed` from BullMQ job state.
- **Pros:** No duplicated state.
- **Cons:** Job data expires/gets cleaned; DB queries (listing, Phase 04 panel) cannot filter by status; couples reads to Redis availability. The challenge explicitly requires the lifecycle "refletido no banco".

**Recommendation:** **Option A (persisted draft → processing → ready | failed, API-triggered, bounded retries)** — it is the lifecycle the phase specifies, persisted in the DB as required, with a portable trigger and idempotency from `jobId`; transient errors are retried by BullMQ and only the final outcome is written.

**Decision:** A (Persisted draft → processing → ready | failed, API-triggered, 3 attempts then `failed`)

---

## TD-10: Test Strategy for Storage, Queue and Worker

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The project tests integration against the real Compose services (shared PostgreSQL, Mailpit) and runs integration/e2e `--runInBand`. Phase 03 adds MinIO, Redis and a worker that shells out to FFmpeg. Tests run inside the `nestjs-api` container; the `video-worker` container also consumes the queue, so a test that enqueues a job could have it picked up by the long-running worker (running whatever code it has loaded) instead of the code under test.

**Options:**

### Option A: Real MinIO/Redis/FFmpeg; the test process runs its own worker on an isolated queue prefix
- Integration specs hit the real MinIO and Redis services; `ffmpeg` is installed in the shared dev image. E2E specs boot the API **and** the worker module in-process, with a test-only BullMQ prefix so the `video-worker` container never consumes test jobs. A tiny committed sample video (a few KB, generated with FFmpeg) drives the full upload → process → stream flow. The running `video-worker` container is exercised separately by a scripted smoke check.
- **Pros:** No mocks for anything the Compose stack provides (matches the project's integration style); deterministic — the code under test is what processes the job; the real container is still verified end-to-end.
- **Cons:** `ffmpeg` in the API dev image; e2e flow needs polling with a timeout; the sample fixture is a binary file in the repo.

### Option B: Rely on the running `video-worker` container during e2e
- E2E enqueues on the shared queue and waits for the container to process it.
- **Pros:** Exercises the real deployment topology in the test itself.
- **Cons:** The container may run stale code (watch mode lag) → flaky; tests depend on container state outside Jest's control; parallel developer activity can steal jobs.

### Option C: Mock S3 client and queue in unit tests only
- `jest.fn()` for the S3 client and `Queue.add`; FFmpeg output stubbed.
- **Pros:** Fast, no infra.
- **Cons:** Doesn't prove presigned URLs, multipart completion, Range/206 or FFmpeg parsing work; contradicts the project's practice of testing against real services.

**Recommendation:** **Option A (real infra, in-process worker on an isolated prefix, plus a scripted smoke test of the container)** — every external system the phase introduces is exercised for real while keeping the tests deterministic; unit specs still mock collaborators per the testing rules, but integration/e2e never mock what Compose provides.

**Decision:** A (Real infra, in-process worker on an isolated queue namespace, plus scripted smoke test of the container)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | A (BullMQ on Redis) | C (RabbitMQ) |
| TD-02 | Cross-layer | Upload Strategy for Files up to 10 GB | A (Presigned multipart, direct to storage) | A |
| TD-03 | Backend | Object Storage Layout and Access Policy | A (Single private bucket + presigned URLs) | A |
| TD-04 | Backend | S3 Client Library | A (AWS SDK v3) | A |
| TD-05 | Backend | Video Worker Runtime | A (Same codebase, separate entry point + container) | A |
| TD-06 | Backend | Metadata Extraction and Thumbnail Generation | A (Spawn ffprobe/ffmpeg on a presigned URL) | A |
| TD-07 | Backend | Unique Video URL Identifier | A (Random base64url slug + unique index) | A |
| TD-08 | Cross-layer | Streaming and Download Delivery | A (302 to presigned URL) | A |
| TD-09 | Backend | Video Status Lifecycle and Failure Handling | A (draft → processing → ready/failed, API-triggered, bounded retries) | A |
| TD-10 | Backend | Test Strategy for Storage, Queue and Worker | A (Real infra, in-process worker on isolated prefix + smoke) | A |
