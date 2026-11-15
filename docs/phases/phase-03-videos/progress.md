# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/9 completed

### SI-03.1 — Infraestrutura: storage, broker, FFmpeg e configuração
- **Status:** completed
- **Tests:** 13/13 passing (env.validation.integration-spec.ts)
- **Observations:** 
  - Official minio/minio and minio/mc images are no longer published; used pgsty/minio and pgsty/mc pinned to dated release tags (library-refs.md).
  - Host ports of MinIO/RabbitMQ are parametrized in compose.yaml (MINIO_API_PORT etc.) because 9000 may be busy on the host; S3_PUBLIC_ENDPOINT must match the published port.
  - Re-running minio-init (docker compose run --rm minio-init) exits 0 with the bucket kept (mc mb --ignore-existing).

### SI-03.2 — Entidade Video e migration CreateVideos
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — StorageModule (S3/MinIO)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — MessagingModule (RabbitMQ): topologia, publisher e consumer
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Início do upload: rascunho, URLs de partes, retomada e cancelamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Conclusão do upload e disparo do processamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Video worker: metadados, thumbnail e ciclo de status
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Detalhe, streaming e download do vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Contrato OpenAPI, documentação de IA e smoke do container worker
- **Status:** pending
- **Tests:** —
- **Observations:** none
