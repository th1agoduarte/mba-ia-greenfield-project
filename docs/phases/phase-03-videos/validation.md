---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-15T14:19:51-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-15T13:49:43-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-09 relies on BullMQ jobId dedup/retries but TD-01 decided RabbitMQ"
    resolved_by: phase-03-videos/TD-09
  - id: IC-2
    status: resolved
    summary: "TD-10 isolates tests with a BullMQ prefix but TD-01 decided RabbitMQ"
    resolved_by: phase-03-videos/TD-10
  - id: AMB-1
    status: resolved
    summary: "Who may read/stream/download a video in Phase 03 (owner vs anonymous)"
    resolved_by: phase-03-videos/TD-08, phase-03-videos/TD-02
  - id: AMB-2
    status: resolved
    summary: "TD-02/TD-06 limits given only as 'suggested/e.g.' values"
    resolved_by: phase-03-videos/TD-02, phase-03-videos/TD-06
  - id: MD-1
    status: resolved
    summary: "No TD for RabbitMQ client library and retry/dead-letter topology"
    resolved_by: phase-03-videos/TD-11, phase-03-videos/TD-12
  - id: ICC-1
    status: resolved
    summary: "TD-03/TD-10 real MinIO vs testing guide 'local filesystem' storage"
    resolved_by: phase-03-videos/TD-10
  - id: ICC-2
    status: resolved
    summary: "Global throttler 10 req/60s vs part-URL batches and stream redirects"
    resolved_by: phase-03-videos/TD-02, phase-03-videos/TD-08
  - id: AMB-3
    status: resolved
    summary: "TD-12 retry delay only 'suggested'; stream/download URL TTL unstated"
    resolved_by: phase-03-videos/TD-12, phase-03-videos/TD-08
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-11, phase-03-videos/TD-12)_ — No TD for RabbitMQ client library and retry/dead-letter topology. Closed by a `/research` round that added TD-11 (A: `amqplib` + `amqp-connection-manager`) and TD-12 (A: TTL retry queue + parking queue, idempotent consumer).
- **IC-1** _(resolved_by phase-03-videos/TD-09)_ — TD-09 relies on BullMQ jobId dedup/retries but TD-01 decided RabbitMQ. Revision appended to TD-09 (same Option A): mechanism re-expressed for RabbitMQ — no `jobId`; idempotent consumer guarded on `status = processing`; 3 attempts via the TD-12 retry queue, then `failed`.
- **IC-2** _(resolved_by phase-03-videos/TD-10)_ — TD-10 isolates tests with a BullMQ prefix but TD-01 decided RabbitMQ. Revision appended to TD-10 (same Option A): test isolation through configurable exchange/queue names (`RABBITMQ_*` env), not a BullMQ prefix.
- **AMB-1** _(resolved_by phase-03-videos/TD-08, phase-03-videos/TD-02)_ — Who may read/stream/download a video in Phase 03 (owner vs anonymous). User chose owner-only for Phase 03: every video endpoint requires JWT and ownership through the caller's channel; stream/download require `ready`. Recorded as Revisions on TD-08 and TD-02.
- **AMB-2** _(resolved_by phase-03-videos/TD-02, phase-03-videos/TD-06)_ — TD-02/TD-06 limits given only as 'suggested/e.g.' values. User confirmed the suggested values as decided parameters (10 GiB, 64 MiB parts, 1 h URLs, ≤100 part URLs per request; thumbnail at 10% of duration, JPEG 1280 px). Recorded as Revisions on TD-02 and TD-06.
- **ICC-1** _(resolved_by phase-03-videos/TD-10)_ — TD-03/TD-10 real MinIO vs testing guide 'local filesystem' storage. User kept real MinIO; TD-10 Revision schedules the update of the testing guide's external-system strategy (Object Storage → MinIO in Docker; Message Queue → RabbitMQ) within this phase.
- **ICC-2** _(resolved_by phase-03-videos/TD-02, phase-03-videos/TD-08)_ — Global throttler 10 req/60s vs part-URL batches and stream redirects. User chose `@SkipThrottle()` on the videos controller (same pattern as `AppController`). Recorded as Revisions on TD-02 and TD-08.
- **AMB-3** _(resolved_by phase-03-videos/TD-12, phase-03-videos/TD-08)_ — TD-12 retry delay only 'suggested'; stream/download URL TTL unstated. Raised by the third validate run after the first resolve; the user confirmed 5 s retry delay (configurable) and 1 h presigned stream/download URLs, recorded as Revisions on TD-12 and TD-08.
