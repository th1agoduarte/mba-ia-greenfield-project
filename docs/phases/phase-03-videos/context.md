---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/phases/phase-03-videos/library-refs.md: "2026-11-15T14:31:24-03:00"
  docs/project-plan.md: "2026-11-15T12:38:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-15T14:31:12-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-15T12:38:57-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-11-15T12:38:57-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-11-15T12:38:57-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-11-15T12:38:57-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-15T12:38:57-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-15T12:38:57-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-15T14:20:53-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** categorias, edição de informações do vídeo, visibilidade público/unlisted, fluxo rascunho → publicação e painel do canal (Fase 04); player, página de visualização, contagem de views e acesso anônimo à visualização (Fase 05); interações sociais (Fase 06); home, busca e deploy (Fase 07). Interface de vídeo no `next-frontend/`.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — the video UI is not part of this phase (backend-only challenge scope); no capability bullet of Fase 03 names a screen.

**Sequencing notes:** Depends on Fase 01 (Docker Compose stack, config, migrations) and Fase 02 (users, 1:1 channels, global JWT guard, domain error envelope). "Pontos de Atenção" of `docs/project-plan.md` also apply: 10 GB upload must not lock the system and should allow resuming after a connection failure; processing runs in background; short unique URLs; plan storage growth; streaming without full download.

**Neighbors (for boundary detection only):**

- **Fase 02:** cadastro, login, canal criado automaticamente — owner of `users`/`channels` and the auth guard reused here.
- **Fase 04:** categorias, edição do vídeo, visibilidade, rascunho → publicação, painel do canal — consumes the `videos` table created here.
- **Fase 05:** player, página do vídeo, acesso anônimo, botão de download, vídeos unlisted — consumes the streaming/download endpoints created here.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | C (RabbitMQ) | — |
| phase-03-videos/TD-02 | phase | Cross-layer | Upload Strategy for Files up to 10 GB | decided | A (Presigned multipart, direct to storage) | — |
|     └─ Last revision: 2026-11-15 — Params fixed (10 GiB, 64 MiB parts, 1 h URLs, 100/batch); owner-only; @SkipThrottle | | | | | | |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Layout and Access Policy | decided | A (Single private bucket + presigned URLs) | — |
| phase-03-videos/TD-04 | phase | Backend | S3 Client Library | decided | A (AWS SDK v3) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-05 | phase | Backend | Video Worker Runtime | decided | A (Same codebase, separate entry point and container) | — |
| phase-03-videos/TD-06 | phase | Backend | Metadata Extraction and Thumbnail Generation | decided | A (Spawn ffprobe/ffmpeg CLI reading a presigned URL) | — |
|     └─ Last revision: 2026-11-15 — Params fixed: frame at 10% of duration, JPEG 1280 px; no video stream = non-retryable | | | | | | |
| phase-03-videos/TD-07 | phase | Backend | Unique Video URL Identifier | decided | A (Random 11-char base64url slug + unique index + retry) | — |
| phase-03-videos/TD-08 | phase | Cross-layer | Streaming and Download Delivery | decided | A (302 redirect to a presigned URL) | — |
|     └─ Last revision: 2026-11-15 — Presigned stream/download URLs valid 1 h | | | | | | |
| phase-03-videos/TD-09 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | A (draft → processing → ready/failed, API-triggered, 3 attempts) | — |
|     └─ Last revision: 2026-11-15 — Mechanism re-expressed for RabbitMQ: idempotent consumer + TD-12 retry queue | | | | | | |
| phase-03-videos/TD-10 | phase | Backend | Test Strategy for Storage, Queue and Worker | decided | A (Real infra, in-process worker on isolated namespace + smoke) | — |
|     └─ Last revision: 2026-11-15 — Isolation via configurable exchange/queue names; testing guide updated to MinIO/RabbitMQ | | | | | | |
| phase-03-videos/TD-11 | phase | Backend | RabbitMQ Client Library | decided | A (amqplib + amqp-connection-manager) | amqplib, amqp-connection-manager |
|     └─ Last revision: 2026-11-15 — amqp-connection-manager pinned to 4.x (5.x pulls an ESM-only dep) | | | | | | |
| phase-03-videos/TD-12 | phase | Backend | Messaging Topology, Retry Policy and Idempotent Consumer | decided | A (TTL retry queue + parking queue, idempotent consumer) | — |
|     └─ Last revision: 2026-11-15 — Retry delay fixed at 5 s (configurable), 3 attempts | | | | | | |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-10 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05, phase-03-videos/TD-10, phase-03-videos/TD-11, phase-03-videos/TD-12 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-09 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-06, phase-03-videos/TD-09, phase-03-videos/TD-10, phase-03-videos/TD-12 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06, phase-03-videos/TD-10 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ on Redis — it is the queue the NestJS docs document first-party, and it gives retries/backoff, terminal `failed` state and `jobId` dedup out of the box, which TD-09 depends on; Redis is a small, explicit queue container that matches the separate "Message Queue" box of the architecture diagram, while pg-boss would load the API's database and RabbitMQ would require hand-building the retry topology.

**Note:** Decision C (RabbitMQ) was chosen over the recommendation. Consequence recorded in the TD: retries with backoff, terminal failure and duplicate-safe processing are not built in and must be specified (exchange/queue/dead-letter topology, retry policy, idempotent consumer) together with the Node client library.

**Decision rationale (user):** RabbitMQ was chosen over the BullMQ recommendation for four reasons: (1) it is a market-standard, language-agnostic AMQP broker, so a future worker in another stack can consume the same queue; (2) dead-lettering, per-queue TTL, durable queues, publisher confirms and a management UI are native broker features instead of a job library on top of Redis; (3) it keeps Redis free for caching in later phases instead of making it the queue; (4) the challenge is also an opportunity to practise AMQP messaging. The cost accepted with it — building retries/backoff and idempotency in the application — is covered by TD-11 and TD-12.

**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** Presigned multipart, direct to storage — it is the only option where a 10 GB transfer has zero cost on the API and that is natively resumable, and the S3 limits (5 GiB single PUT, 10,000 parts) make multipart mandatory anyway; the extra endpoints are a fixed, testable contract. Suggested parameters: max size **10 GiB** (`10 × 1024³` bytes) validated at initiation; fixed part size chosen so that 10 GiB fits well under 10,000 parts (e.g., 64 MiB → 160 parts); presigned URLs short-lived (e.g., 1 h) and issued in batches.

**Libraries:** —

**Revisions:**
- 2026-11-15 — Parameters fixed: max declared size **10 GiB** (`10737418240` bytes); part size **64 MiB** (`67108864` bytes; 10 GiB → 160 parts, well under 10,000); presigned URLs valid **1 h**; at most **100** part URLs per request. Rationale: AMB-2 — values confirmed as decided parameters by the user.
- 2026-11-15 — All upload endpoints (initiate, part URLs, list parts, complete, abort) are owner-only: JWT required and the video must belong to the caller's channel. Rationale: AMB-1 — Phase 03 access rule set to owner-only (visibility is Phase 04, anonymous viewing is Phase 05).
- 2026-11-15 — The videos controller opts out of the global throttler with `@SkipThrottle()` (same pattern as `AppController`); a 10 GiB upload needs well over 10 requests/minute (part URL batches, resume). Rationale: ICC-2 — user chose `@SkipThrottle()` on the videos controller.

### phase-03-videos/TD-03

**Recommendation:** Single private bucket + presigned URLs — it keeps every asset private until the visibility rules of Phases 04/05 exist, and needs only one bucket to bootstrap; the API signs URLs with a configurable public endpoint (`S3_PUBLIC_ENDPOINT`) distinct from the internal one (`S3_ENDPOINT`), so presigned links work from the host and from inside the Compose network. The bucket is created idempotently at stack start-up by a one-shot Compose service. Stable public thumbnails can be revisited in Phase 07 with a Revision if a CDN is introduced.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** AWS SDK v3 — presigning `UploadPart` is required by the direct multipart strategy (TD-02 A) and only the AWS SDK exposes it, and it targets production S3 natively.

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-05

**Recommendation:** Same codebase, separate entry point and container — it honors the separate Worker container of the architecture and keeps FFmpeg load out of the API, while reusing the entity, config and test infrastructure the project already has, so the worker is covered by the same `npm test` / `tsc` / `lint` gates.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Direct CLI spawn reading a presigned URL — avoids a deprecated dependency and the 10 GB local copy; metadata and a single frame only need ranged reads. Suggested thumbnail frame: 10% of the duration (bounded to the video length), JPEG scaled to 1280 px wide; an input with no video stream fails processing (TD-09).

**Libraries:** —

**Revisions:**
- 2026-11-15 — Parameters fixed: thumbnail frame at **10% of the duration**, JPEG scaled to **1280 px** wide (keeping aspect ratio); input without a video stream is a non-retryable failure. Rationale: AMB-2 — values confirmed as decided parameters by the user.

### phase-03-videos/TD-07

**Recommendation:** Random base64url slug with DB uniqueness — short, non-enumerable and dependency-free, with uniqueness enforced by a `UNIQUE` index plus retry, reusing a pattern the codebase already has.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** 302 redirect to a presigned URL — progressive streaming via HTTP Range is what the requirement asks for, storage already implements 206 correctly, and the API stays out of the data path while still authorizing each request; HLS can be a later Revision if adaptive bitrate becomes a requirement.

**Libraries:** —

**Revisions:**
- 2026-11-15 — Access rule for Phase 03: video details, `stream` and `download` are **owner-only** (JWT + video belongs to the caller's channel); `stream`/`download` require status `ready`. Opening to other users/anonymous is left to Phases 04/05. The videos controller uses `@SkipThrottle()` (seeking re-requests `stream`). Rationale: AMB-1 + ICC-2 — owner-only chosen by the user; throttling opt-out chosen by the user.
- 2026-11-15 — Presigned `stream`/`download` URLs are valid **1 h** (same lifetime as the upload part URLs). Rationale: AMB-3 — value confirmed by the user.

### phase-03-videos/TD-09

**Recommendation:** Persisted draft → processing → ready | failed, API-triggered, bounded retries — it is the lifecycle the phase specifies, persisted in the DB as required, with a portable trigger and idempotency from `jobId`; transient errors are retried by BullMQ and only the final outcome is written.

**Libraries:** —

**Revisions:**
- 2026-11-15 — Mechanism re-expressed for RabbitMQ (TD-01 C, TD-12 A): no `jobId`; "complete" publishes one `video.uploaded` message after setting `processing`; duplicate deliveries are harmless because the worker only processes videos still in `processing` and writes the final state with a conditional update; retries = 3 attempts total via the TTL retry queue (TD-12), then `failed` with the error message stored. Rationale: IC-1 — same Option A, mechanism text referred to BullMQ.

### phase-03-videos/TD-10

**Recommendation:** Real infra, in-process worker on an isolated prefix, plus a scripted smoke test of the container — every external system the phase introduces is exercised for real while keeping the tests deterministic; unit specs still mock collaborators per the testing rules, but integration/e2e never mock what Compose provides.

**Libraries:** —

**Revisions:**
- 2026-11-15 — Queue isolation for tests uses configurable exchange/queue names (env `RABBITMQ_*` names): tests declare their own namespace so the `video-worker` container never consumes test messages (no BullMQ prefix). Rationale: IC-2 — same Option A, isolation mechanism referred to BullMQ.
- 2026-11-15 — The testing guide's external-system strategy (`.claude/skills/testing-guide-nestjs-project/references/external-systems.md`) is updated in this phase: Object Storage → real MinIO in Docker; Message Queue → RabbitMQ. Rationale: ICC-1 — user kept real MinIO; the guide's "local filesystem" strategy predates the storage decision.

### phase-03-videos/TD-11

**Recommendation:** amqplib + amqp-connection-manager — it is the only option that fits the installed Nest version without a framework upgrade and gives the explicit control over confirms, acks and queue arguments that the retry/dead-letter topology (TD-12) needs; the extra code is a small, testable module. Depends on TD-01.

**Libraries:** amqplib, amqp-connection-manager

**Revisions:**
- 2026-11-15 — `amqp-connection-manager` pinned to the **4.x** line (`^4.1.15`, same API) instead of 5.x. Rationale: 5.x depends on `promise-breaker` 7, which is ESM-only and cannot be loaded by Jest's CommonJS runtime used by the project; 4.1.15 (2025-09) depends on the CJS `promise-breaker` 6. Found during SI-03.4.

### phase-03-videos/TD-12

**Recommendation:** TTL retry queue + parking queue, `x-attempt` header, idempotent consumer — it delivers TD-09's "3 attempts then `failed`" with a real delay between attempts using only stock RabbitMQ features, keeps the terminal-failure write in the same worker that processed the video, and makes duplicate deliveries harmless by guarding on `status = processing`. Suggested delay: 5 s; exchange/queue names configurable so tests can use their own namespace (TD-10).

**Libraries:** —

**Revisions:**
- 2026-11-15 — Retry delay fixed at **5 s** (queue `x-message-ttl` of the retry queue, configurable by env); 3 attempts total. Rationale: AMB-3 — value confirmed by the user.

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** @nestjs/config — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Joi — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Namespaced/grouped with registerAs — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Shared registerAs factory — `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — OWASP-recommended choice for a greenfield project; native build dependency is a one-time Docker setup cost.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** @nestjs/passport — plugin architecture costs little and aligns with official NestJS docs.

**Note:** Decision deliberately diverged from the Recommendation — custom guards with `@nestjs/jwt` only (smaller dependency surface).

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Refresh Token Rotation — strongest security model with automatic theft detection; PostgreSQL already in the stack.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Random Opaque Tokens in DB — revocable, short URLs, decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** @nestjs-modules/mailer — best NestJS integration; SMTP works with Mailpit locally and any provider in production.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer — the documented NestJS approach; the project already uses decorators extensively.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — machine-readable error codes in a simple `{ statusCode, error, message }` format the Next.js frontend can switch on.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** @nestjs/throttler — native guard integration with `@SkipThrottle()` for exemptions; single-instance, in-memory storage is sufficient.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Opaque refresh tokens — DB lookup is mandatory, so a JWT signature adds no security value.

**Note:** Decision deliberately diverged — JWT kept to reuse the `@nestjs/jwt` infrastructure.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** `[a-z0-9_]` allowlist with `user_<random>` fallback — simplest and most portable handle scheme.

**Libraries:** —

### phase-02-auth-frontend/TD-01 … TD-07

**Recommendation:** Frontend session/BFF decisions (cookie session via iron-session, server-side refresh helper, react-hook-form + Zod, Route Handlers as the only NestJS caller, RSC-first session hydration). Relevant here only as the consumer model of TD-08's redirect: the browser never calls the API directly; Route Handlers proxy it.

**Libraries:** iron-session, react-hook-form, @hookform/resolvers

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` — preserves `class-validator` (phase-02-auth/TD-06); the CLI plugin with `classValidatorShim: true` infers DTO schemas from existing decorators.

**Libraries:** @nestjs/swagger

**Revisions:**
- 2026-05-12 — The CLI plugin only infers DTO schemas; operation docs, per-status typed responses, error contracts (aligned with the phase-02-auth/TD-07 envelope) and examples require explicit decorators (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`).

### openapi-docs-nestjs/TD-02

**Recommendation:** Both runtime UI and exported `openapi.json` — the marginal cost over the runtime UI is one npm script; the committed spec is the foundation for FE codegen.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Swagger UI only in dev/staging (env flag) — defensive posture; the committed `openapi.json` is the consultable spec outside the UI.

**Libraries:** —

### next-frontend-openapi-typing/TD-01 … TD-05

**Recommendation:** `openapi-typescript` + `openapi-fetch` types-first client; FE keeps a committed copy of the spec refreshed by the repo-root `scripts/sync-openapi.sh`; committed codegen output; single `lib/api/contracts.ts`; MSW handlers typed via `paths`.

**Libraries:** openapi-typescript, openapi-fetch

### next-frontend-config-base/TD-01 … TD-03

**Recommendation:** Zod 4 env schema via `@t3-oss/env-nextjs`; strict BFF with a single server-only `API_URL` (no public backend URL in the browser).

**Libraries:** zod, @t3-oss/env-nextjs

### next-frontend-msw-foundation/TD-01 … TD-04

**Recommendation:** Per-domain MSW handler modules + barrel, `setupServer` only, hand-written fixtures, universal handler set with `onUnhandledRequest: "error"`.

**Libraries:** —

## Inherited Conventions

- Config uses `@nestjs/config` namespaced `registerAs(name, () => ({...}))` factories, one file per domain in `src/config/`. _(from phase 01)_
- Env vars validated by Joi `envValidationSchema` in `src/config/env.validation.ts`; forRoot uses `allowUnknown: true, abortEarly: false`. _(from phase 01)_
- New config factories must be added to `ConfigModule.forRoot({ isGlobal: true, load: [...] })` in `src/app.module.ts`. _(from phase 01)_
- Config injected via `@Inject(xxxConfig.KEY)` + `ConfigType<typeof xxxConfig>`; factory also callable as plain function (CLI/scripts). _(from phase 01)_
- `data-source.ts` does `import 'dotenv/config'` then calls `databaseConfig()`; DB params never duplicated vs AppModule. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `inject: [databaseConfig.KEY]`, `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Domain errors extend abstract `DomainException(errorCode, httpStatus, message)` in `src/common/exceptions/domain.exception.ts`; services throw them. _(from phase 02)_
- `DomainExceptionFilter` + `ValidationExceptionFilter` (global, main.ts) emit envelope `{ statusCode, error, message }`; error = UPPER_SNAKE code. _(from phase 02)_
- Validation failures → 400 `{ statusCode: 400, error: 'VALIDATION_ERROR', message: string[] }`. _(from phase 02)_
- Global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` in main.ts. _(from phase 02)_
- Request DTOs live in `<module>/dto/*.dto.ts` with class-validator decorators; swagger plugin (`classValidatorShim`) infers schemas. _(from phase 02)_
- `JwtAuthGuard` is global via `APP_GUARD` in AuthModule: routes are protected by default; opt out with `@Public()` (auth/decorators). _(from phase 02)_
- Authenticated user is read with `@CurrentUser()` param decorator → `JwtPayload { sub, email }` (`src/auth/auth.types.ts`). _(from phase 02)_
- `ThrottlerGuard` is also a global APP_GUARD (10 req/60s); non-auth controllers opt out with `@SkipThrottle()` (see AppController). _(from phase 02)_
- Feature modules use `TypeOrmModule.forFeature([...])`; services inject `@InjectRepository(X) private readonly xRepository: Repository<X>`. _(from phase 02)_
- No custom repository classes; modules export `TypeOrmModule` + service (e.g. UsersModule). _(from phase 02)_
- Entities: `@Entity('snake_plural')`, `@PrimaryGeneratedColumn('uuid')`, snake_case columns, `created_at`/`updated_at` date columns. _(from phase 02)_
- Migrations: `src/database/migrations/<ts>-PascalName.ts`, class `PascalName<ts>`, generated via `npm run migration:generate`. _(from phase 02)_
- Tests: `*.spec.ts` unit, `*.integration-spec.ts` (runInBand, real Postgres), `test/*.e2e-spec.ts` (AppModule + supertest). _(from phase 02)_
- E2E bootstraps replicate main.ts manually: same ValidationPipe + `useGlobalFilters(DomainExceptionFilter, ValidationExceptionFilter)`. _(from phase 02)_
- Test helpers in `src/test/`: `createTestDataSource(entities, opts)`, `cleanAllTables(ds)` (hard-coded DELETE list: add new tables). _(from phase 02)_
- External-service helpers are plain HTTP clients in `src/test/` (e.g. `mailpit.ts` hits the Mailpit API by `MAIL_HOST`). _(from phase 02)_
- Controllers: `@ApiTags`, `@ApiOperation({ summary })`, `@ApiResponse` per status; protected ones `@ApiBearerAuth('access-token')`. _(from phase 02)_
- Error responses documented as `schema: { $ref: getSchemaPath(ApiErrorEnvelope) }` (src/common/openapi/api-error-envelope.dto.ts). _(from phase 02)_
- Swagger UI at `/api/docs` only when `SWAGGER_ENABLED=true`; `openapi.json` exported via `npm run openapi:export` and committed. _(from phase 02)_
- FE copy refreshed by repo-root `scripts/sync-openapi.sh` → `next-frontend/openapi.json`, then `npm run openapi:types`. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` not initialized in that phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | UI surfaces delivered by phase-02-auth-frontend. |
| "Confirmação de conta via e-mail com link de ativação" (UI) | deferred | phase-02-auth-frontend | deferred_to_next_phase — confirmation landing screen de-scoped. |
| "Logout" (UI) | deferred | phase-02-auth-frontend | deferred_to_next_phase — button lives in authenticated chrome. |
| "Recuperação de senha (destination screen)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — reset-password screen absent from Figma. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` § 3 Feature Implementation Checklist and `references/external-systems.md`)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit (branch logic, mocked repo) + Integration (DB contract) |
| Service with DB only (no branching) | Integration (DB contract) |
| Service with configured lib | Unit with real lib + test config |
| Service with side-effect dependency (storage, queue, email) | Integration against the real capture service |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — no unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard | E2E (+ Unit when it has complex internal logic) |
| Exception filter | Unit + E2E |

External-system strategies documented by the guide: PostgreSQL — real (Docker); Email — Mailpit (real SMTP capture); Message Queue — "real broker in Docker, technology TBD"; **Object Storage — "Local filesystem storage in development and tests. S3 in production"** (local adapter, no mocking).

_Update 2026-11-15 (ICC-1, applied in SI-03.9):_ the guide now documents Object Storage — real MinIO in Docker and Message Queue — real RabbitMQ, with the test isolation helpers (`useInternalStorageEndpointForTests`, `useIsolatedQueueNamespaceForTests`).
