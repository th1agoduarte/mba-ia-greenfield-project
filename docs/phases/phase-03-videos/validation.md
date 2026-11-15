---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 7
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-15T13:19:46-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-15T13:13:39-03:00"
issues:
  - id: IC-1
    status: open
    summary: "TD-09 relies on BullMQ jobId dedup/retries but TD-01 decided RabbitMQ"
  - id: IC-2
    status: open
    summary: "TD-10 isolates tests with a BullMQ prefix but TD-01 decided RabbitMQ"
  - id: AMB-1
    status: open
    summary: "Who may read/stream/download a video in Phase 03 (owner vs anonymous)"
  - id: AMB-2
    status: open
    summary: "TD-02/TD-06 limits given only as 'suggested/e.g.' values"
  - id: MD-1
    status: open
    summary: "No TD for RabbitMQ client library and retry/dead-letter topology"
  - id: ICC-1
    status: open
    summary: "TD-03/TD-10 real MinIO vs testing guide 'local filesystem' storage"
  - id: ICC-2
    status: open
    summary: "Global throttler 10 req/60s vs part-URL batches and stream redirects"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `phase-03-videos/TD-09` Recommendation states "idempotency from `jobId`; transient errors are retried by BullMQ", while `phase-03-videos/TD-01` decided **C (RabbitMQ)**, which has neither `jobId` deduplication nor built-in retry/backoff. The lifecycle decision (draft → processing → ready | failed, 3 attempts) is still valid, but its mechanism cites a library that is not in the stack. Explicit choice: keep TD-09 Option A and record a Revision re-expressing the retry/idempotency mechanism in RabbitMQ terms (consumer idempotent on `status = processing`, retry count tracked per message, terminal `failed` after the last attempt) — or supersede TD-09.
- **IC-2** — `phase-03-videos/TD-10` Recommendation isolates the in-process test worker "on an isolated prefix" (a BullMQ concept) while TD-01 decided RabbitMQ. Explicit choice: keep TD-10 Option A with a Revision naming the RabbitMQ isolation mechanism (e.g., dedicated vhost or test-only queue/exchange names), or supersede TD-10.

### Ambiguities

- **AMB-1** — The capabilities "Reprodução via streaming" and "Download do vídeo pelo usuário" do not say who may stream/download, and the neighbor Fase 05 owns "Acesso anônimo à visualização de vídeos" and unlisted rules, while Fase 04 owns visibility/publication. Without a boundary, the Authorization Matrix cannot be written (owner-only vs any authenticated user vs anonymous; only `ready` videos vs any status). Explicit choice: define the Phase 03 access rule for GET video / stream / download (and for the upload endpoints).
- **AMB-2** — `phase-03-videos/TD-02` lists the max size (10 GiB), part size ("e.g., 64 MiB"), presigned URL lifetime ("e.g., 1 h") and batching only as *suggested* parameters; `phase-03-videos/TD-06` gives the thumbnail frame (10% of duration, 1280 px JPEG) as *suggested*. These values appear in DTO validation, Joi config and tests, so they must be fixed before API Contracts can be written. Explicit choice: confirm (or change) the suggested values as decided parameters.

### Missing Decisions

- **MD-1** — "Serviço de processamento em segundo plano (filas)": TD-01 chose RabbitMQ and its own Decision note says the "exchange/queue/dead-letter topology, retry policy, idempotent consumer" and "the Node client library" still have to be specified. These are strategic choices with real alternatives (raw `amqplib` + `amqp-connection-manager` vs `@golevelup/nestjs-rabbitmq` vs `@nestjs/microservices` RMQ transport; retry via TTL'd retry queue + DLX vs delayed requeue) and no TD covers them. Explicit choice: run `/research` to add a TD (related_phases=[3]) covering the RabbitMQ client library and the messaging/retry topology.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

- **ICC-1** — `phase-03-videos/TD-03` (MinIO bucket bootstrapped in Compose) and `phase-03-videos/TD-10` (integration/e2e against the real MinIO) conflict with the inherited testing strategy in `## Testing Requirements`: "Object Storage — Local filesystem storage in development and tests. S3 in production" (local adapter, no MinIO). Explicit choice: (a) keep TD-03/TD-10 and update the testing guide's external-system strategy to "real S3-compatible storage (MinIO) in Docker"; (b) revise TD-10 to use a local filesystem adapter in tests (presigned URLs and multipart would then be untested).
- **ICC-2** — Inherited convention: "`ThrottlerGuard` is also a global APP_GUARD (10 req/60s); non-auth controllers opt out with `@SkipThrottle()`". TD-02 issues presigned part URLs in batches (a 10 GiB upload with 64 MiB parts = 160 parts, plus resume/list calls) and TD-08 makes the player re-request `stream` on seek after URL expiry — both can exceed 10 requests/minute for a single legitimate upload or playback. Explicit choice: decide whether the videos controller opts out with `@SkipThrottle()` (as AppController does) or uses a dedicated limit.

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

_No issues resolved yet._
