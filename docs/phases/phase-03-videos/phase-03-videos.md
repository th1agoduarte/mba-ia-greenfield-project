---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-15T15:21:57-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-15T15:21:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-15T15:19:38-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-15T12:38:57-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar no `nestjs-project/` o serviço de armazenamento (MinIO/S3) para vídeos e thumbnails, a fila de processamento em segundo plano (RabbitMQ) com um worker FFmpeg, o upload de vídeos de até 10GB direto ao storage com pré-cadastro do vídeo como rascunho, o processamento automático (duração, metadados e thumbnail), a URL única por vídeo e a reprodução via streaming e o download — tudo subindo via Docker Compose.

---

## Step Implementations

### SI-03.1 — Infraestrutura: storage, broker, FFmpeg e configuração

**Description:** Sobe MinIO (com criação idempotente do bucket) e RabbitMQ no `compose.yaml`, instala FFmpeg na imagem de dev e registra as configurações/env validadas que todos os SIs seguintes consomem.

**Technical actions:**

1. Adicionar ao `nestjs-project/compose.yaml` os serviços `minio` (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, healthcheck, porta de API `${MINIO_API_PORT:-9000}` e console), `minio-init` (`pgsty/mc:RELEASE.2026-10-26T00-00-00Z`, `mc mb --ignore-existing` do `S3_BUCKET`, one-shot) e `rabbitmq` (`rabbitmq:4.2.9-management-alpine`, healthcheck); `nestjs-api` passa a depender deles (per `phase-03-videos/TD-01`, `TD-03`; imagens em `library-refs.md`)
2. Instalar `ffmpeg` no `Dockerfile.dev` (per `phase-03-videos/TD-05`, `TD-06`)
3. Instalar `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `amqplib`, `amqp-connection-manager` (per `phase-03-videos/TD-04`, `TD-11`)
4. Criar `src/config/storage.config.ts` (`registerAs('storage')`: endpoint, publicEndpoint, region, accessKey, secretKey, bucket, presignExpiresSeconds=3600) e `src/config/messaging.config.ts` (`registerAs('messaging')`: url, namespace, retryDelayMs=5000, maxAttempts=3) e registrá-los no `ConfigModule.forRoot` do `AppModule` (inherited conventions phase 01)
5. Acrescentar as variáveis `S3_*`, `MINIO_*`, `RABBITMQ_*`, `VIDEO_PROCESSING_*` ao `envValidationSchema` e ao `.env.example` (hosts = nomes de serviço do Compose)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: novas variáveis obrigatórias e defaults | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `db`, `mailpit`, `minio` e `rabbitmq` saudáveis e `minio-init` sai com código 0
- O bucket `S3_BUCKET` existe no MinIO após o `up` e continua existindo após um segundo `up` (idempotente)
- `ffprobe -version` e `ffmpeg -version` executam dentro do container `nestjs-api`
- A aplicação recusa iniciar quando `S3_BUCKET` ou `RABBITMQ_URL` estão ausentes

---

### SI-03.2 — Entidade Video e migration CreateVideos

**Description:** Cria a tabela `videos` ligada ao canal, com status, chaves de storage, duração/metadados e slug único — a base de persistência de toda a fase.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme `### Data Model → Video` (enum `VideoStatus`, `ManyToOne` para `Channel`, `bigint` com transformer para `number`) (per `phase-03-videos/TD-07`, `TD-09`)
2. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` (inherited conventions phase 02)
3. Atualizar `src/database/migrations.integration-spec.ts` (nova migration, tabela `videos` e enum `videos_status_enum`) e `cleanAllTables` em `src/test/create-test-data-source.ts` (apagar `videos` antes de `channels`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: slug único, default `draft`, FK cascade ao apagar canal | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: up cria `videos`, revert remove | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1 — stack e convenções de config prontas

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com índice único em `slug` e FK `channel_id` → `channels`
- Inserir dois vídeos com o mesmo `slug` falha com violação de unicidade
- Um vídeo recém-criado tem `status = 'draft'`
- Apagar o canal apaga seus vídeos

---

### SI-03.3 — StorageModule (S3/MinIO)

**Description:** Encapsula o object storage num serviço próprio — multipart, URLs pré-assinadas e objetos — usado pela API e pelo worker.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` com dois `S3Client` (interno `S3_ENDPOINT`; público `S3_PUBLIC_ENDPOINT` só para assinar), `forcePathStyle: true` e `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-03`, `TD-04`; `library-refs.md`)
2. Métodos: `createMultipartUpload`, `presignUploadPart`, `listParts` (paginado), `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `presignGetObject(key, { downloadFileName? })`, `putObject` (per `phase-03-videos/TD-02`, `TD-08`)
3. Traduzir rejeição de `CompleteMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`) para `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`, `### Error Catalog`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): multipart em 2 partes via URLs pré-assinadas, `listParts`, complete, GET pré-assinado com `Range` → 206, `Content-Disposition` no download, ETag errado → `INVALID_UPLOAD_PARTS` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — MinIO, bucket e `storage.config`

**Acceptance criteria:**

- Um arquivo enviado em duas partes por `PUT` nas URLs pré-assinadas fica íntegro no bucket após o complete
- Um GET na URL pré-assinada com `Range: bytes=0-99` retorna `206` com 100 bytes
- A URL de download traz `Content-Disposition: attachment; filename="<nome>"`
- Completar com um ETag inválido lança `INVALID_UPLOAD_PARTS`

---

### SI-03.4 — MessagingModule (RabbitMQ): topologia, publisher e consumer

**Description:** Entrega a fila de processamento em segundo plano: conexão resiliente, declaração da topologia, publicação confirmada de `video.uploaded` e o mecanismo de consumo com retry e fila de estacionamento.

**Technical actions:**

1. Criar `src/messaging/messaging.module.ts` com um provider de conexão `amqp-connection-manager` (fechado em `onApplicationShutdown`) e a declaração da topologia de `### Events/Messages` derivada de `RABBITMQ_NAMESPACE` (per `phase-03-videos/TD-11`, `TD-12`)
2. Criar `src/messaging/video-processing.publisher.ts` — `publishVideoUploaded(videoId, attempt = 1)`, mensagem persistente, resolve no confirm do broker (per `phase-03-videos/TD-12`)
3. Criar `src/messaging/video-processing.consumer.ts` — `start(handler)` com `prefetch(1)`; handler retorna `ok` | `retry` | `fail`; `retry` com `x-attempt < maxAttempts` republica em `{ns}.processing.retry`, senão vai para `{ns}.processing.dead`; ack sempre após o handler (per `phase-03-videos/TD-12`, `TD-09`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingPublisher` + `VideoProcessingConsumer` | Integration (RabbitMQ real, namespace de teste): publica e consome; `retry` reentrega após o TTL com `x-attempt` incrementado; após 3 tentativas a mensagem vai para `.dead` | `src/messaging/video-processing.integration-spec.ts` |
| `MessagingModule` | Unit: compilação | `src/messaging/messaging.module.spec.ts` |

**Dependencies:** SI-03.1 — RabbitMQ e `messaging.config`

**Acceptance criteria:**

- Publicar `video.uploaded` coloca uma mensagem persistente em `{ns}.processing`
- Um handler que pede `retry` recebe a mesma mensagem de novo após ~`VIDEO_PROCESSING_RETRY_DELAY_MS`, com `x-attempt` = 2
- Uma mensagem que falha 3 vezes termina em `{ns}.processing.dead` e não é mais entregue
- Mensagens de um namespace não são consumidas por um consumer de outro namespace

---

### SI-03.5 — Início do upload: rascunho, URLs de partes, retomada e cancelamento

**Description:** Implementa o pré-cadastro automático do vídeo como `draft` ao iniciar o upload e o fluxo multipart direto ao storage, sem que os bytes passem pela API.

**Technical actions:**

1. Criar `src/videos/videos.module.ts` (importa `TypeOrmModule.forFeature([Video, Channel])`, `StorageModule`, `MessagingModule`), `src/videos/videos.service.ts` e registrar em `AppModule` (inherited conventions phase 02)
2. `VideosService.initiateUpload(userId, dto)`: resolve o canal do usuário, gera `slug` com retry em colisão (`23505`, até 5 tentativas), cria o `draft` e o multipart; `presignParts`, `listParts`, `abortUpload` (apaga o `draft`) com checagem de dono → `VIDEO_NOT_FOUND` e de estado → `VIDEO_INVALID_STATE`/`INVALID_PART_NUMBER` (per `phase-03-videos/TD-02`, `TD-07`, `TD-09`)
3. Criar DTOs em `src/videos/dto/` (`create-video.dto.ts`, `part-urls.dto.ts`) e as exceções do `### Error Catalog` em `src/common/exceptions/domain.exception.ts`
4. Criar `src/videos/videos.controller.ts` com `POST /videos`, `POST /videos/{slug}/upload/part-urls`, `GET /videos/{slug}/upload/parts`, `DELETE /videos/{slug}/upload` conforme `### API Contracts`, `@SkipThrottle()`, decorators OpenAPI (inherited `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: retry do slug em colisão, dono vs não-dono, estados inválidos, `part_count` | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration (Postgres + MinIO reais): draft persistido com `upload_id` e `storage_key` | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação | `src/videos/videos.module.spec.ts` |
| `VideosController` + DTOs | E2E: contratos, validação (incl. `file_size` > 10 GiB → 400), 401 sem token, 404 para não-dono | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.2 — entidade `Video`; SI-03.3 — `StorageService`; SI-03.4 — `MessagingModule` importado pelo módulo

**Acceptance criteria:**

- `POST /videos` com corpo válido retorna `201` com `slug` de 11 caracteres, `status: "draft"` e `upload.part_size: 67108864`; a linha existe no banco como `draft`
- `POST /videos` com `file_size: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos/{slug}/upload/part-urls` com `part_numbers: [1,2]` retorna `200` com duas URLs `PUT` assinadas para o storage (não para a API)
- `GET /videos/{slug}/upload/parts` após enviar a parte 1 lista `part_number: 1` com seu `etag`
- `DELETE /videos/{slug}/upload` retorna `204` e o vídeo deixa de existir
- Qualquer rota de upload chamada por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`; sem token retorna `401`

---

### SI-03.6 — Conclusão do upload e disparo do processamento

**Description:** Fecha o multipart, muda o vídeo para `processing` e publica `video.uploaded`, iniciando o processamento automático; a operação é idempotente.

**Technical actions:**

1. `VideosService.completeUpload(userId, slug, dto)`: `draft` → `CompleteMultipartUpload` + `HeadObject` (tamanho ≤ 10 GiB), `status = processing`, `upload_id = null`, depois `publishVideoUploaded`; já em `processing` → apenas 202 sem nova publicação; `ready`/`failed` → `VIDEO_INVALID_STATE` (per `phase-03-videos/TD-02`, `TD-09` + Revision, `TD-12`)
2. Criar `src/videos/dto/complete-upload.dto.ts` e a rota `POST /videos/{slug}/upload/complete` (202) conforme `### API Contracts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: ramos draft / processing (idempotente) / ready-failed | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (Postgres + MinIO + RabbitMQ reais): status `processing` e mensagem em `{ns}.processing` | `src/videos/videos.service.integration-spec.ts` |
| Rota complete | E2E: 202, ETag inválido → 400 `INVALID_UPLOAD_PARTS` | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.5 — upload iniciado e partes enviadas

**Acceptance criteria:**

- `POST /videos/{slug}/upload/complete` com as partes corretas retorna `202` com `status: "processing"` e o objeto `videos/{id}/original` existe no bucket
- A conclusão publica exatamente uma mensagem `video.uploaded` com `{ "video_id": <id> }`
- Chamar complete de novo com o vídeo em `processing` retorna `202` e não publica outra mensagem
- Complete com um ETag inválido retorna `400` com `error: "INVALID_UPLOAD_PARTS"` e o vídeo continua `draft`

---

### SI-03.7 — Video worker: metadados, thumbnail e ciclo de status

**Description:** Entrega o worker FFmpeg num processo/container separado que consome `video.uploaded`, extrai duração e metadados, gera a thumbnail e grava `ready`/`failed` no banco.

**Technical actions:**

1. Criar `src/media/media-probe.service.ts` — `spawn('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', url])` e `spawn('ffmpeg', ['-ss', t, '-i', url, '-frames:v','1','-vf','scale=1280:-2', '-f','image2','pipe:1'])` sobre a URL pré-assinada interna, com timeout; sem stream de vídeo → `NonRetryableProcessingError` (per `phase-03-videos/TD-06` + Revision)
2. Criar `src/videos/video-processing.service.ts` — `process(videoId)`: ignora vídeo fora de `processing`; probe → thumbnail em 10% da duração → `putObject(videos/{id}/thumbnail.jpg)` → update condicional `WHERE status = 'processing'` para `ready` com `duration_seconds`, `metadata`, `thumbnail_key`; `markFailed(videoId, message)` (per `phase-03-videos/TD-09` + Revision)
3. Criar `src/worker.module.ts` + `src/worker.ts` (`NestFactory.createApplicationContext`, liga `VideoProcessingConsumer.start` ao `VideoProcessingService`: erro retryable → `retry`, não-retryable ou última tentativa → `markFailed` + `fail`) e scripts `start:worker` / `start:worker:dev` no `package.json` (per `phase-03-videos/TD-05`, `TD-12`)
4. Adicionar o serviço `video-worker` ao `compose.yaml` (mesma imagem/build e volume da API, espera `node_modules`, `restart: unless-stopped`, depende de `db`, `minio`, `rabbitmq`) (per `phase-03-videos/TD-05`)
5. Gerar e commitar um vídeo de amostra pequeno (`test/fixtures/sample.mp4`, ~2 s, gerado com `ffmpeg -f lavfi testsrc`) para os testes (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService` | Integration (ffmpeg real + MinIO): duração/codec do fixture, JPEG gerado, arquivo não-vídeo → erro não-retryable | `src/media/media-probe.service.integration-spec.ts` |
| `VideoProcessingService` | Unit: ignora status ≠ processing; ramos retry/fail | `src/videos/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration (Postgres + MinIO + ffmpeg reais): `processing` → `ready` com duração, metadata e thumbnail no bucket; corrompido → `failed` com `processing_error` | `src/videos/video-processing.service.integration-spec.ts` |
| `WorkerModule` | Unit: compilação | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.3 — storage; SI-03.4 — consumer; SI-03.6 — mensagens publicadas

**Acceptance criteria:**

- `docker compose up -d` sobe o container `video-worker` junto com o backend e ele fica consumindo `{ns}.processing`
- Um vídeo válido em `processing` termina `ready` com `duration_seconds > 0`, `metadata.video_codec` preenchido e `videos/{id}/thumbnail.jpg` (JPEG, 1280 px de largura) no bucket
- Um arquivo que não é vídeo termina `failed` com `processing_error` preenchido, sem novas tentativas
- Uma falha transitória é tentada 3 vezes no total antes de `failed`
- Uma mensagem duplicada para um vídeo já `ready` não altera o registro

---

### SI-03.8 — Detalhe, streaming e download do vídeo

**Description:** Expõe o vídeo pela URL única: detalhes com status/metadados/thumbnail, reprodução via streaming e download, ambos por redirect para URL pré-assinada, sem bytes passando pela API.

**Technical actions:**

1. `VideosService.findOwned(userId, slug)` e `getStreamUrl` / `getDownloadUrl` (exigem `ready` → senão `VIDEO_NOT_READY`) usando `presignGetObject` (download com `ResponseContentDisposition` e `original_file_name`) (per `phase-03-videos/TD-08` + Revisions)
2. Rotas `GET /videos/{slug}` (200, com `thumbnail_url` pré-assinada), `GET /videos/{slug}/stream` e `GET /videos/{slug}/download` (302 com `Location`) conforme `### API Contracts`, com decorators OpenAPI
3. E2E do fluxo completo em `test/videos-flow.e2e-spec.ts`: API + worker in-process (`WorkerModule`) no namespace de teste, upload do fixture por URLs pré-assinadas, complete, polling até `ready`, stream (302 → GET com `Range` → 206), download (302 → `Content-Disposition: attachment`) (per `phase-03-videos/TD-10` + Revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (stream/download) | Unit: `ready` vs não-`ready`, dono vs não-dono | `src/videos/videos.service.spec.ts` |
| Rotas GET/stream/download | E2E: 200/302/404/409 | `test/videos.e2e-spec.ts` |
| Fluxo completo | E2E: upload → processamento → stream 206 → download | `test/videos-flow.e2e-spec.ts` |

**Dependencies:** SI-03.7 — vídeos chegam a `ready`

**Acceptance criteria:**

- `GET /videos/{slug}` de um vídeo `ready` retorna `200` com `status: "ready"`, `duration_seconds`, `metadata` e `thumbnail_url` que responde `200 image/jpeg`
- `GET /videos/{slug}/stream` retorna `302`; o `Location` responde `206 Partial Content` a `Range: bytes=0-1023`
- `GET /videos/{slug}/download` retorna `302`; o `Location` responde com `Content-Disposition: attachment; filename="<original_file_name>"`
- `GET /videos/{slug}/stream` de um vídeo em `processing` retorna `409` com `error: "VIDEO_NOT_READY"`
- Dois vídeos enviados pelo mesmo usuário recebem slugs diferentes e cada slug resolve só o seu vídeo

---

### SI-03.9 — Contrato OpenAPI, documentação de IA e smoke do container worker

**Description:** Fecha a fase deixando contrato, documentação de IA e verificação do worker real coerentes com o código.

**Technical actions:**

1. Regenerar e commitar `nestjs-project/openapi.json` (`npm run openapi:export`) e estender `src/openapi-export.integration-spec.ts` com as rotas `/videos` (summary, `access-token`, envelope de erro) (inherited `openapi-docs-nestjs/TD-02`)
2. Atualizar `.claude/skills/testing-guide-nestjs-project/references/external-systems.md`: Object Storage → MinIO real em Docker; Message Queue → RabbitMQ (per `phase-03-videos/TD-10` Revision — ICC-1)
3. Atualizar `CLAUDE.md` (raiz: arquitetura com RabbitMQ, MinIO e worker) e `nestjs-project/CLAUDE.md` (serviços do Compose, módulo de vídeos, endpoints, fila/worker, storage, comandos do worker)
4. Criar `nestjs-project/scripts/smoke-video-pipeline.sh` — do host, cadastra/confirma/loga um usuário, envia um vídeo pelas URLs pré-assinadas, completa e espera o container `video-worker` deixá-lo `ready`, testando stream (206) e download (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| OpenAPI export | Integration: rotas `/videos` com summary, segurança e envelope de erro | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.8 — todas as rotas existem

**Acceptance criteria:**

- `openapi.json` commitado contém as 8 operações de `/videos`
- `scripts/smoke-video-pipeline.sh` termina com sucesso contra a stack do `docker compose up` (vídeo `ready` processado pelo container `video-worker`)
- Todo arquivo, endpoint e comando citado nos `CLAUDE.md` existe no código

---

### SI-03.10 — Amendment: correções do code review e alinhamento plano ↔ código

**Description:** Registra o que a implementação mudou em relação aos SIs já executados (que não são reescritos) e as correções do `/code-review` + auditoria independente, para que o plano continue rastreável ao código.

**Technical actions:**

1. Desvios dos SIs executados, todos registrados no `progress.md`: `src/worker.module.spec.ts` → `src/worker.module.integration-spec.ts` (abre conexão real); o e2e de fluxo carrega `VideoProcessingModule` junto do `AppModule` em vez de `WorkerModule` (duas raízes TypeORM no mesmo processo quebram o DataSource); `publishVideoUploaded(videoId)` sem parâmetro `attempt` (o retry republica pelo consumer); `VideosModule` usa `TypeOrmModule.forFeature([Video])` + `ChannelsModule.findByUserId` em vez de `forFeature([Video, Channel])`; configs registradas em `src/config/root.imports.ts` (compartilhado por `AppModule` e `WorkerModule`); `findOwned` → `findOwnedOrFail`/`getVideo`; `amqp-connection-manager` 4.x (TD-11 Revision)
2. `completeUpload`: publica só quando o update condicional para `processing` afeta a linha; a compensação não restaura `upload_id`; arquivo montado acima de 10 GiB → `failed`, objeto apagado e `400 UPLOAD_TOO_LARGE` (`### Error Catalog`, `### API Contracts`, transição `draft → failed` no `### Data Model`)
3. Consumer: `nack` com requeue quando o reenvio para retry/dead falha; `x-attempt` ausente ou inválido conta como 1
4. `MediaProbeService`: sem duração no container (WebM gravado por navegador) usa a duração do stream ou `null`; `avg_frame_rate` `0/0` → `null`; respostas `403`/`404` do storage são não-retryable
5. `npm test` e `npm run test:e2e` rodam `--runInBand` (banco compartilhado, como o `nestjs-project/CLAUDE.md` determina); `messaging.module` e `videos.module` specs viram `*.integration-spec.ts` (conectam no RabbitMQ)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingConsumer` | Unit: `x-attempt` inválido, parking na última tentativa, `nack` quando o reenvio falha | `src/messaging/video-processing.consumer.spec.ts` |
| `VideosService.completeUpload` | Unit: concorrência, compensação, `UPLOAD_TOO_LARGE` | `src/videos/videos.service.spec.ts` |
| `MediaProbeService` | Integration: WebM sem duração no container | `src/media/media-probe.service.integration-spec.ts` |

**Dependencies:** SI-03.9 — fase implementada

**Acceptance criteria:**

- `docker compose exec nestjs-api npm test` (sem flags) e `npm run test:e2e` passam
- Dois `complete` concorrentes publicam no máximo uma mensagem `video.uploaded`
- `complete` com arquivo montado acima de 10 GiB retorna `400` com `error: "UPLOAD_TOO_LARGE"` e o objeto não existe mais no bucket
- Uma falha ao reenviar para a fila de retry não deixa a entrega sem ack/nack

---

### SI-03.11 — Amendment: correções da revisão de segurança e de código pós-entrega

**Description:** Registra as correções de uma revisão de segurança e de um code review independentes feitos depois da entrega (achados SR-1…SR-11), sem reescrever os SIs executados, para que o plano continue rastreável ao código.

**Technical actions:**

1. `completeUpload` repetível: em `processing`, republica `video.uploaded` (o worker ignora duplicatas) — recupera chamada que caiu entre gravar `processing` e publicar e mensagem estacionada na `.dead` com o vídeo ainda `processing` (SR-1, per `phase-03-videos/TD-09` Revision)
2. `presignUploadPart(key, uploadId, partNumber, contentLength)` assina `content-length` com o tamanho exato da parte (`partSizeFor`: 64 MiB, a última com o resto do `file_size` declarado); o storage recusa corpo de outro tamanho (SR-2, per `phase-03-videos/TD-02` Revision)
3. `@SkipThrottle()` sai do controller e fica só em `part-urls`, `upload/parts`, `GET /videos/{slug}`, `stream` e `download`; `POST /videos`, `complete` e `DELETE …/upload` voltam ao throttler global (SR-3, per `phase-03-videos/TD-02` Revision)
4. Usuário sem canal → `ChannelNotFoundException` (`404 CHANNEL_NOT_FOUND`, `### Error Catalog`); falha do abort de compensação é logada sem perder o erro original (SR-4)
5. `MediaProbeService`: `toProbeResult` rejeita imagem estática e ausência de duração positiva fora de Matroska/WebM (SR-5); `-format_whitelist`/`-protocol_whitelist` em ffprobe e ffmpeg contra HLS/DASH (SR-9); `redactUrls` remove URLs e query strings do texto de erro antes do `processing_error` (SR-8) (per `phase-03-videos/TD-06` Revision)
6. Download com `filename*=UTF-8''…` (RFC 5987/6266) além do `filename=` ASCII (SR-6, per `phase-03-videos/TD-08` Revision)
7. Consumer: entrega com `redelivered` conta como tentativa — vai para a retry com `x-attempt + 1` ou para a `.dead` sem rodar o handler (SR-7, per `phase-03-videos/TD-12` Revision)
8. `compose.yaml`: console do MinIO e management do RabbitMQ em `127.0.0.1`; credenciais root do MinIO na API e expiração de uploads incompletos (padrão do MinIO, 24 h) documentadas (SR-10, SR-11, per `phase-03-videos/TD-03` Revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: republica em `processing`, `CHANNEL_NOT_FOUND`, erro original preservado quando o abort falha, `partSizeFor` e tamanho passado ao presign | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration (Postgres + MinIO + RabbitMQ): segundo `complete` em `processing` publica de novo | `src/videos/videos.service.integration-spec.ts` |
| `StorageService` | Integration (MinIO real): `PUT` maior/menor que o assinado → `403 SignatureDoesNotMatch`; `filename*` com nome não-ASCII e CR/LF | `src/storage/storage.service.integration-spec.ts` |
| `toProbeResult`, `redactUrls` | Unit: imagens (png_pipe, image2, gif…), sem duração, WebM sem duração aceito, redação de URLs | `src/media/media-probe.service.spec.ts` |
| `MediaProbeService` | Integration (ffmpeg + MinIO): PNG/JPEG/GIF recusados; manifesto HLS e DASH recusados (`not on whitelist`); `file://` recusado; erro de objeto inexistente sem host/assinatura | `src/media/media-probe.service.integration-spec.ts` |
| `VideoProcessingService` | Integration: PNG enviado como vídeo termina `failed`, nunca `ready` | `src/videos/video-processing.service.integration-spec.ts` |
| `VideoProcessingConsumer` | Unit: reentrega → retry com `x-attempt + 1` / dead quando esgotada / laço do nack limitado; Integration (RabbitMQ real): entrega perdida por "crash" volta como tentativa 2 | `src/messaging/video-processing.consumer.spec.ts`, `src/messaging/video-processing.integration-spec.ts` |
| `VideosController` | E2E: `404 CHANNEL_NOT_FOUND`; 11º `POST /videos` no minuto → `429`; polling/part-urls/parts sem `429` | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.10 — amendment anterior

**Acceptance criteria:**

- Um `complete` repetido em `processing` publica `video.uploaded` de novo e responde `202`; dois `complete` concorrentes sobre um `draft` continuam publicando uma vez
- Um `PUT` de parte com tamanho diferente do assinado recebe `403` do storage e a parte não é gravada
- O 11º `POST /videos` no mesmo minuto recebe `429`; status, URLs de partes e lista de partes não são limitados
- Um manifesto HLS/DASH ou uma imagem PNG terminam `failed` sem requisição às URLs internas do manifesto; um MP4 válido continua `ready`
- `processing_error` não contém host do storage, access key id nem assinatura

---

## Technical Specifications

### Data Model

#### Video

Table `videos` (per `phase-03-videos/TD-02`, `TD-03`, `TD-07`, `TD-09`).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | not null, FK → `channels.id` ON DELETE CASCADE |
| slug | varchar(11) | not null, unique — random base64url of `crypto.randomBytes(8)` (per `phase-03-videos/TD-07`) |
| title | varchar(100) | not null |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` (per `phase-03-videos/TD-09`) |
| original_file_name | varchar(255) | not null |
| content_type | varchar(100) | not null |
| size_bytes | bigint | not null — declared size, ≤ `10737418240` (per `phase-03-videos/TD-02`) |
| storage_key | varchar(255) | not null — `videos/{id}/original` (per `phase-03-videos/TD-03`) |
| upload_id | varchar(1024) | nullable — S3 multipart `UploadId`; cleared when the upload completes |
| thumbnail_key | varchar(255) | nullable — `videos/{id}/thumbnail.jpg`, set when `ready` |
| duration_seconds | numeric(12,3) | nullable — set when `ready` |
| metadata | jsonb | nullable — `{ format_name, bit_rate, width, height, video_codec, audio_codec, frame_rate }` from ffprobe |
| processing_error | text | nullable — last error message when `failed` |
| created_at | timestamp | default now() |
| updated_at | timestamp | default now(), updated on change |

**Relations:** `Video` belongs to one `Channel` (`@ManyToOne`, `channel_id`, ON DELETE CASCADE); no inverse `@OneToMany` is declared on `Channel`.
**Indexes:** unique on `slug`; index on `channel_id`.
**Migration:** `src/database/migrations/<timestamp>-CreateVideos.ts` (generated via `npm run migration:generate`).

**Status transitions** (per `phase-03-videos/TD-09`):

| From | To | Who | When |
|------|----|-----|------|
| — | `draft` | API | `POST /videos` (multipart upload initiated) |
| `draft` | `processing` | API | `POST /videos/{slug}/upload/complete` after `CompleteMultipartUpload` succeeds |
| `processing` | `ready` | Worker | metadata + thumbnail saved (conditional update `WHERE status = 'processing'`) |
| `processing` | `failed` | Worker | non-retryable error, or last of 3 attempts failed (`processing_error` stored) |
| `draft` | `failed` | API | `complete` finds the assembled object above 10 GiB (`UPLOAD_TOO_LARGE`) |
| `draft` | (deleted) | API | `DELETE /videos/{slug}/upload` (multipart aborted) |

#### Storage layout (MinIO/S3)

Single private bucket `S3_BUCKET` (default `streamtube-videos`) created by the one-shot Compose service `minio-init` (per `phase-03-videos/TD-03`):

| Object key | Written by | Read by |
|------------|-----------|---------|
| `videos/{id}/original` | Client, via presigned `UploadPart` URLs (per `phase-03-videos/TD-02`) | Worker (ffprobe/ffmpeg over presigned GET, per `phase-03-videos/TD-06`); client via `stream`/`download` redirects (per `phase-03-videos/TD-08`) |
| `videos/{id}/thumbnail.jpg` | Worker (`PutObject`, `image/jpeg`) | Client via presigned `thumbnail_url` in `GET /videos/{slug}` |

No public bucket policy. Presigned URLs are signed against `S3_PUBLIC_ENDPOINT`; server-side calls use `S3_ENDPOINT` (per `phase-03-videos/TD-03`).

### API Contracts

All routes live in `VideosController` (`@ApiTags('videos')`, `@ApiBearerAuth('access-token')`). The global throttler (10 req/60 s, `429`) applies to `POST /videos`, `complete` and `DELETE …/upload`; `@SkipThrottle()` is set only on part-urls, upload/parts, `GET /videos/{slug}`, stream and download (per `phase-03-videos/TD-02` and `TD-08` Revisions; narrowed in SI-03.11). All require `Authorization: Bearer <access_token>` (global `JwtAuthGuard`). `{slug}` is the unique video identifier (per `phase-03-videos/TD-07`). Errors use the inherited envelope `{ statusCode, error, message }` (per `phase-02-auth/TD-07`).

#### POST /videos (SI-03.5)

Initiates the upload: creates the `draft` video and the S3 multipart upload (per `phase-03-videos/TD-02`, `TD-09`).

**Request headers:**
- Content-Type: application/json

**Request body:**
- title: string, required — 1..100 characters
- file_name: string, required — 1..255 characters
- file_size: integer, required — 1..10737418240 (10 GiB)
- content_type: string, required — must start with `video/`

**Response 201:**
- id: string (uuid)
- slug: string (11 chars)
- title: string
- status: `"draft"`
- upload: `{ part_size: 67108864, part_count: number, max_urls_per_request: 100 }` — `part_count = ceil(file_size / part_size)`

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation (including `file_size` above 10 GiB)
- 401: missing/invalid access token
- 404 CHANNEL_NOT_FOUND: the authenticated user has no channel _(SI-03.11)_
- 429: global throttler (10 requests/60 s) _(SI-03.11)_

---

#### POST /videos/{slug}/upload/part-urls (SI-03.5)

Returns presigned `UploadPart` URLs for the requested part numbers (per `phase-03-videos/TD-02`).

**Request body:**
- part_numbers: integer[], required — 1..100 items, each 1..`part_count`, unique

**Response 200:**
- urls: `[{ part_number: number, url: string }]` — PUT the part bytes to `url`; keep the `ETag` response header. Each URL is signed for the exact part size (`content-length`: 64 MiB, the last part = `file_size − (part_count − 1) × 64 MiB`); the storage answers `403` to a body of any other size _(SI-03.11)_
- expires_in: number — `3600` seconds

**Error responses:**
- 400 VALIDATION_ERROR: invalid `part_numbers`
- 400 INVALID_PART_NUMBER: a part number is greater than the video's `part_count`
- 404 VIDEO_NOT_FOUND: slug does not exist or the video belongs to another channel
- 409 VIDEO_INVALID_STATE: video is not `draft`

---

#### GET /videos/{slug}/upload/parts (SI-03.5)

Lists the parts already stored, so an interrupted upload can resume (per `phase-03-videos/TD-02`).

**Response 200:**
- parts: `[{ part_number: number, etag: string, size: number }]`

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_INVALID_STATE: video is not `draft`

---

#### DELETE /videos/{slug}/upload (SI-03.5)

Aborts the multipart upload and removes the `draft` video.

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_INVALID_STATE: video is not `draft`

---

#### POST /videos/{slug}/upload/complete (SI-03.6)

Completes the multipart upload, moves the video to `processing` and publishes `video.uploaded` (per `phase-03-videos/TD-02`, `TD-09`, `TD-12`). Repeatable: calling it again while `processing` returns 202 and republishes `video.uploaded` (the worker ignores duplicates); concurrent calls on a `draft` publish once _(SI-03.11; it was a no-op before)_.

**Request body:**
- parts: `[{ part_number: integer ≥ 1, etag: string }]`, required — 1..10000 items

**Response 202:**
- id, slug, title: as in `POST /videos`
- status: `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: invalid body
- 400 INVALID_UPLOAD_PARTS: storage rejected the part list (missing part, wrong ETag or order)
- 400 UPLOAD_TOO_LARGE: the assembled file exceeds 10 GiB (video set to `failed`, object deleted)
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_INVALID_STATE: video is `ready` or `failed`
- 429: global throttler (10 requests/60 s) _(SI-03.11)_

---

#### GET /videos/{slug} (SI-03.8)

**Response 200:**
- id, slug, title, status
- original_file_name, content_type, size_bytes: number
- duration_seconds: number | null
- metadata: object | null
- thumbnail_url: string | null — presigned GET (1 h) when `thumbnail_key` is set
- processing_error: string | null
- created_at, updated_at: ISO-8601

**Error responses:**
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/{slug}/stream (SI-03.8)

**Response 302:** `Location` = presigned GET of `videos/{id}/original` (1 h, per `phase-03-videos/TD-08`). The storage answers `Range` requests with `206 Partial Content`.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: status is not `ready`

---

#### GET /videos/{slug}/download (SI-03.8)

**Response 302:** `Location` = presigned GET with `response-content-disposition=attachment; filename="<ASCII-safe original_file_name>"; filename*=UTF-8''<percent-encoded original_file_name>` (1 h, per `phase-03-videos/TD-08`; `filename*` added in SI-03.11).

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

### Authorization Matrix

Owner = the authenticated user whose channel (`channels.user_id = sub`) owns the video (per `phase-03-videos/TD-02` and `TD-08` Revisions — AMB-1). A non-owner receives `404 VIDEO_NOT_FOUND` (existence is not revealed).

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ (401) | ✓ (creates in own channel) | — |
| POST /videos/{slug}/upload/part-urls | ✗ | ✗ (404) | ✓ |
| GET /videos/{slug}/upload/parts | ✗ | ✗ (404) | ✓ |
| DELETE /videos/{slug}/upload | ✗ | ✗ (404) | ✓ |
| POST /videos/{slug}/upload/complete | ✗ | ✗ (404) | ✓ |
| GET /videos/{slug} | ✗ | ✗ (404) | ✓ |
| GET /videos/{slug}/stream | ✗ | ✗ (404) | ✓ (`ready` only) |
| GET /videos/{slug}/download | ✗ | ✗ (404) | ✓ (`ready` only) |

### Error Catalog

Inherited envelope and `VALIDATION_ERROR` from phase 02. New domain exceptions in `src/common/exceptions/domain.exception.ts`:

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Slug does not exist or the video belongs to another channel |
| VIDEO_INVALID_STATE | 409 | Upload operation on a video that is not `draft` (or complete on `ready`/`failed`) |
| VIDEO_NOT_READY | 409 | `stream`/`download` on a video whose status is not `ready` |
| INVALID_PART_NUMBER | 400 | Requested part number greater than the video's `part_count` |
| INVALID_UPLOAD_PARTS | 400 | `CompleteMultipartUpload` rejected (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`) |
| CHANNEL_NOT_FOUND | 404 | `POST /videos` by an authenticated user who has no channel (e.g. a still-valid JWT of a removed user) _(added in SI-03.11; it was a 500)_ |
| UPLOAD_TOO_LARGE | 400 | The assembled object exceeds 10 GiB (part sizes are chosen by the client); the video becomes `failed` and the object is deleted _(added by the code review after SI-03.9)_ |

Worker-side failures are not HTTP errors: they set `status = failed` and `processing_error` (per `phase-03-videos/TD-09`); URLs and query strings are stripped from that text (SI-03.11).

### Events/Messages

#### video.uploaded

**Payload:**

```json
{ "video_id": "uuid" }
```

**Headers:** `x-attempt: 1..3` (per `phase-03-videos/TD-12`)
**Producer:** `VideoProcessingPublisher` in the API, from `VideosService.completeUpload` (per `phase-03-videos/TD-09`, `TD-11`)
**Consumer:** `VideoProcessingConsumer` in the `video-worker` process (per `phase-03-videos/TD-05`, `TD-11`)
**Trigger:** `POST /videos/{slug}/upload/complete` after `CompleteMultipartUpload` succeeds and the video is set to `processing`, and again on each repeated call while the video is `processing` (SI-03.11).
**Delivery semantics:** at-least-once — persistent message, publisher confirms, `prefetch(1)`, ack after the DB write; the consumer ignores videos not in `processing` (per `phase-03-videos/TD-12`, `TD-09` Revision).

**Topology** (names derived from `RABBITMQ_NAMESPACE`, default `videos`; tests use their own namespace per `phase-03-videos/TD-10` Revision):

| Entity | Name | Arguments |
|--------|------|-----------|
| Exchange | `{ns}` | direct, durable |
| Queue | `{ns}.processing` | durable; bound with routing key `video.uploaded` |
| Queue | `{ns}.processing.retry` | durable; `x-message-ttl` = `VIDEO_PROCESSING_RETRY_DELAY_MS` (5000); `x-dead-letter-exchange` = `{ns}`, `x-dead-letter-routing-key` = `video.uploaded` |
| Queue | `{ns}.processing.dead` | durable; parking queue for messages that exhausted the attempts |

**Retry policy** (per `phase-03-videos/TD-12`, `TD-09`): retryable error and `x-attempt < VIDEO_PROCESSING_MAX_ATTEMPTS` (3) → publish copy to `{ns}.processing.retry` with `x-attempt + 1`, ack original. Non-retryable error (no video stream, still image, no positive duration, demuxer/protocol not on the whitelist, object missing) or last attempt → set `failed` + `processing_error`, publish copy to `{ns}.processing.dead`, ack. A redelivered message (`redelivered = true`) counts as a used attempt: copy to the retry queue with `x-attempt + 1` (or to the dead queue when exhausted) without running the handler _(SI-03.11)_.

---

## Dependency Map

```
SI-03.1 (root) — infra, config, deps
├── SI-03.2 — depends on SI-03.1 (convenções de config/stack)
├── SI-03.3 — depends on SI-03.1 (MinIO + storage.config)
└── SI-03.4 — depends on SI-03.1 (RabbitMQ + messaging.config)
        SI-03.5 — depends on SI-03.2 + SI-03.3 + SI-03.4 (entidade, storage, módulo de mensageria)
        └── SI-03.6 — depends on SI-03.5 (partes enviadas antes do complete)
            └── SI-03.7 — depends on SI-03.3 + SI-03.4 + SI-03.6 (mensagens video.uploaded)
                └── SI-03.8 — depends on SI-03.7 (vídeos ready para stream/download)
                    └── SI-03.9 — depends on SI-03.8 (todas as rotas para OpenAPI/docs/smoke)
                        └── SI-03.10 — depends on SI-03.9 (amendment pós-review)
                            └── SI-03.11 — depends on SI-03.10 (amendment da revisão de segurança)
```

---

## Deliverables

- [ ] SI-03.1 — Infraestrutura: storage, broker, FFmpeg e configuração
- [ ] SI-03.2 — Entidade Video e migration CreateVideos
- [ ] SI-03.3 — StorageModule (S3/MinIO)
- [ ] SI-03.4 — MessagingModule (RabbitMQ): topologia, publisher e consumer
- [ ] SI-03.5 — Início do upload: rascunho, URLs de partes, retomada e cancelamento
- [ ] SI-03.6 — Conclusão do upload e disparo do processamento
- [ ] SI-03.7 — Video worker: metadados, thumbnail e ciclo de status
- [ ] SI-03.8 — Detalhe, streaming e download do vídeo
- [ ] SI-03.9 — Contrato OpenAPI, documentação de IA e smoke do container worker
- [ ] SI-03.10 — Amendment: correções do code review e alinhamento plano ↔ código
- [ ] SI-03.11 — Amendment: correções da revisão de segurança e de código pós-entrega

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
