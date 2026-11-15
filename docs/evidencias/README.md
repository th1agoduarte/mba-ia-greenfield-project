# Evidências — Fase 03 (Upload e Processamento de Vídeos)

Execuções feitas em 2026-11-15 contra a stack do `nestjs-project/compose.yaml` (Docker 29, Compose v5), na branch `feature/phase-03-videos`. O roteiro de verificação está em [`VALIDACAO.md`](../../VALIDACAO.md).

## Definition of Done

| Verificação | Comando (dentro de `nestjs-project/`) | Resultado | Log |
|-------------|----------------------------------------|-----------|-----|
| Unit + integração | `docker compose exec nestjs-api npm test -- --runInBand` | **35 suítes, 215 testes passando** | [dod-npm-test.log](dod-npm-test.log) |
| E2E | `docker compose exec nestjs-api npm run test:e2e` | **5 suítes, 71 testes passando** (rodado 2× seguidas) | [dod-test-e2e.log](dod-test-e2e.log) |
| Type-check | `docker compose exec nestjs-api npx tsc --noEmit` | código de saída **0** | [dod-tsc.log](dod-tsc.log) |
| Lint | `docker compose exec nestjs-api npm run lint` | código de saída **0**, sem erros | [dod-lint.log](dod-lint.log) |
| Checagem negativa | limite trocado para 5 GiB → `test/videos.e2e-spec.ts -t "10 GiB"` | falha como esperado (`expected 201 "Created", got 400`) e o arquivo foi restaurado | [negative-check.log](negative-check.log) |

Os testes de integração e e2e usam MinIO, RabbitMQ, PostgreSQL e FFmpeg **reais** (sem mocks). O e2e [`test/videos-flow.e2e-spec.ts`](../../nestjs-project/test/videos-flow.e2e-spec.ts) cobre o fluxo inteiro: upload multipart → fila → worker → `ready` → stream (206) → download.

## Upload de ~10 GiB pelo container do worker

[`scripts/smoke-video-pipeline.sh`](../../nestjs-project/scripts/smoke-video-pipeline.sh) roda do host, como um cliente real. O arquivo foi um vídeo válido de **10.700.449.812 bytes (9,97 GiB; 37 min 48 s de 1080p H.264)**, gerado com `ffmpeg -stream_loop … -c copy` e não commitado.

| Etapa | Resultado ([smoke-10gib.log](smoke-10gib.log)) |
|-------|-------------------------------------------------|
| `POST /videos` | `201`, `status: draft`, `part_count: 160` (partes de 64 MiB) |
| Envio das partes | **160 `PUT`s direto para `http://localhost:9002/streamtube-videos/…`** (MinIO), nenhum byte pela API; `GET /upload/parts` → 160 partes |
| `POST …/upload/complete` | `202`, `status: processing` |
| Container `video-worker` | `ready` com `duration_seconds: 2268.567`, metadados h264/1920×1080 e thumbnail `image/jpeg`. O ffprobe/ffmpeg leu só os trechos necessários por Range, então o processamento levou menos de um ciclo de polling (2 s) |
| Streaming | `GET /stream` → `302`; storage com `Range: bytes=0-1023` → **`206`, 1024 bytes** |
| Download | `GET /download` → `302` → `Content-Disposition: attachment; filename="video-10gib.mp4"`; o arquivo baixado é **idêntico** ao enviado (`cmp`) |
| Tempo total | 149 s |

**A API não trava durante o upload.** Durante os 149 s, uma sonda chamou `GET /` a cada segundo ([smoke-10gib-api-latency.log](smoke-10gib-api-latency.log)):

- 145/145 respostas `200`; latência p50 1,5 ms, p95 3,6 ms, p99 16,9 ms, máx. 31,7 ms.
- CPU do container `nestjs-api` ([smoke-10gib-api-container-stats.log](smoke-10gib-api-container-stats.log)): p50 0,83%, p95 1,45%.
- O único pico (74%) é a primeira amostra, às 14:12:38, durante o cadastro/login (hash Argon2), antes de o envio começar.

## Smoke com o vídeo de amostra e estado final

- [smoke-sample.log](smoke-sample.log) — mesmo script com `test/fixtures/sample.mp4` (35 KB, 2 s): `SMOKE OK`.
- [db-videos.txt](db-videos.txt) — linha da tabela `videos` após o smoke (`ready`, duração, thumbnail).
- [compose-ps.txt](compose-ps.txt) — serviços da stack: `minio`, `minio-init` (`Exited (0)`), `rabbitmq`, `video-worker` junto com `nestjs-api`, `db` e `mailpit`.

> Ambiente desta execução: as portas 8025 e 9000 do host já estavam ocupadas, então o `.env` local usou `MINIO_API_PORT=9002` (com `S3_PUBLIC_ENDPOINT=http://localhost:9002`) e a UI do Mailpit em 8026 (`MAILPIT_URL=http://localhost:8026`). Os padrões do `.env.example` continuam 9000/8025.
