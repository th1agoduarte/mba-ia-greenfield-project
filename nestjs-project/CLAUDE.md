# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO / RabbitMQ:** `docker compose ps` shows `minio` and `rabbitmq` as `healthy` and `minio-init` as `Exited (0)` (bucket created)
- **Video worker:** `docker compose logs video-worker` shows `Consuming videos.processing` (it waits for `node_modules` on a fresh clone)

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP `1025`, UI/API `8025`
- `minio` — S3-compatible object storage (`pgsty/minio`), API `${MINIO_API_PORT:-9000}`, console `${MINIO_CONSOLE_PORT:-9001}`
- `minio-init` — one-shot: creates the private bucket `S3_BUCKET` (`mc mb --ignore-existing`) and exits
- `rabbitmq` — RabbitMQ 4.2 (video processing queue), AMQP `5672`, management UI `15672`
- `video-worker` — same image/source as the API; runs `npm run start:worker:dev` (`src/worker.ts`, FFmpeg) and restarts on changes in `src/`

The image (`Dockerfile.dev`) includes `ffmpeg`/`ffprobe`, used by the worker and by the tests that run in `nestjs-api`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker:dev                 # Video worker (normally run by the video-worker service)
npm run start:worker                     # Compiled worker (dist/worker.js)
npm run openapi:export                   # Regenerate openapi.json (commit it after API changes)

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs -f video-worker
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
docker compose run --rm minio-init          # re-create the bucket (idempotent)
scripts/smoke-video-pipeline.sh [file]      # full pipeline from the host, through the video-worker container
```

`scripts/smoke-video-pipeline.sh` needs the API dev server running, `jq` on the host and `MAILPIT_URL` pointing to the Mailpit UI port (default `http://localhost:8025`).

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

Phase 03 variables (validated in `src/config/env.validation.ts`, documented in `.env.example`):

- `S3_ENDPOINT` — storage endpoint used by the API/worker inside the Compose network (`http://minio:9000`).
- `S3_PUBLIC_ENDPOINT` — host the presigned URLs are **signed for**; it must be reachable by the client and match the published port (`http://localhost:${MINIO_API_PORT}`). Presigned URLs embed the host, so a mismatch makes uploads/streams fail with a signature error.
- `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` / `S3_REGION` / `S3_PRESIGN_EXPIRES_SECONDS` (3600).
- `RABBITMQ_URL` (`amqp://…@rabbitmq:5672`), `RABBITMQ_NAMESPACE` (`videos` → exchange `videos`, queues `videos.processing`, `.retry`, `.dead`), `VIDEO_PROCESSING_RETRY_DELAY_MS` (5000), `VIDEO_PROCESSING_MAX_ATTEMPTS` (3).
- `MINIO_API_PORT`, `MINIO_CONSOLE_PORT`, `RABBITMQ_PORT`, `RABBITMQ_MANAGEMENT_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD` — only read by `compose.yaml` (host ports and broker credentials).

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos module (Phase 03)

Decisions: `docs/decisions/technical-decisions-phase-03-videos.md`. Plan/progress: `docs/phases/phase-03-videos/`.

| Path | Responsibility |
|------|----------------|
| `src/videos/entities/video.entity.ts` | `videos` table (`VideoStatus`: `draft` → `processing` → `ready` \| `failed`), owned by a channel (`channel_id`, cascade) |
| `src/videos/videos.service.ts` | Upload lifecycle (draft + multipart, part URLs, list/abort, complete → publish), owner-only reads, stream/download URLs |
| `src/videos/videos.controller.ts` | HTTP routes below (`@SkipThrottle()`, owner-only; non-owners get `404 VIDEO_NOT_FOUND`) |
| `src/videos/video-processing.service.ts` | Worker logic: ffprobe metadata, thumbnail, `ready`/`failed`; ignores videos not in `processing` (idempotent) |
| `src/videos/video-processing.module.ts`, `src/videos/video-worker.ts` | Worker feature: starts the queue consumer on bootstrap |
| `src/worker.module.ts`, `src/worker.ts` | Worker process root (no HTTP); `src/config/root.imports.ts` holds the config/DB root shared with `AppModule` |
| `src/storage/` | `StorageService` (AWS SDK v3): multipart, presigned PUT/GET (public endpoint), `putObject`, `headObject` |
| `src/messaging/` | RabbitMQ via `amqp-connection-manager`: topology, `VideoProcessingPublisher` (confirms), `VideoProcessingConsumer` (prefetch 1, retry queue with TTL + `x-attempt`, parking queue) |
| `src/media/media-probe.service.ts` | Spawns `ffprobe`/`ffmpeg` on a presigned URL; `NonRetryableProcessingError` for inputs that will never work |

Endpoints (all `Authorization: Bearer`, contract in `openapi.json`):

| Method & route | Result |
|----------------|--------|
| `POST /videos` | `201` draft + `upload { part_size: 67108864, part_count, max_urls_per_request: 100 }`; `file_size` ≤ 10737418240 |
| `POST /videos/{slug}/upload/part-urls` | `200` presigned `PUT` URLs (1 h) for ≤ 100 parts |
| `GET /videos/{slug}/upload/parts` | `200` parts already stored (resume) |
| `POST /videos/{slug}/upload/complete` | `202` `processing` + `video.uploaded` published (idempotent; compensates to `draft` if publishing fails) |
| `DELETE /videos/{slug}/upload` | `204` multipart aborted, draft removed |
| `GET /videos/{slug}` | `200` status, duration, metadata, presigned `thumbnail_url` |
| `GET /videos/{slug}/stream` | `302` to presigned GET (storage answers `Range` with `206`); `409 VIDEO_NOT_READY` unless `ready` |
| `GET /videos/{slug}/download` | `302` to presigned GET with `Content-Disposition: attachment` |

Storage keys: `videos/{id}/original`, `videos/{id}/thumbnail.jpg` in the private bucket `S3_BUCKET`.

### Testing the video stack

- Storage, queue and FFmpeg are tested for real (no mocks in integration/e2e). Before compiling a test module, call `useInternalStorageEndpointForTests()` (`src/test/storage.ts`) — presigned URLs must be signed for `minio:9000` inside the container — and `useIsolatedQueueNamespaceForTests(label)` (`src/test/messaging.ts`) so the `video-worker` container never consumes test messages; delete the namespace in `afterAll` (`deleteQueueNamespace`).
- `test/videos-flow.e2e-spec.ts` runs the whole pipeline: it loads `VideoProcessingModule` into the same app as `AppModule` (`createVideosE2EApp(label, [VideoProcessingModule])`). Do not boot `WorkerModule` next to `AppModule` in one process: two TypeORM roots break the default DataSource.
- Fixture: `test/fixtures/sample.mp4` (2 s H.264/AAC), read with `readSampleVideo()` (`src/test/fixtures.ts`).
- `amqp-connection-manager` is pinned to 4.x: 5.x depends on the ESM-only `promise-breaker@7`, which Jest's CommonJS runtime cannot load.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
