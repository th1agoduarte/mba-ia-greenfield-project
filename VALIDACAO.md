# Validação — Fase 03 (Upload e Processamento de Vídeos)

Roteiro para conferir **cada critério de aceite** do [DESAFIO.md](DESAFIO.md): um comando e o resultado esperado. Os comandos de `docker compose` rodam em `nestjs-project/`. As evidências das execuções estão em [`docs/evidencias/`](docs/evidencias/README.md).

## 0. Preparação

```bash
cd nestjs-project
cp .env.example .env                 # ajuste portas do host se estiverem ocupadas (MINIO_API_PORT + S3_PUBLIC_ENDPOINT)
docker compose up -d --build
docker compose exec nestjs-api npm install
docker compose exec nestjs-api npm run migration:run
```

Esperado: `docker compose ps` com `db`, `mailpit`, `minio`, `rabbitmq` saudáveis, `minio-init` em `Exited (0)` e `video-worker` em `Up`.

## 1. Decisões e planejamento

| # | Critério | Como verificar | Esperado |
|---|----------|----------------|----------|
| 1.1 | Decisões resolvidas e justificadas | `grep -n '^## TD-\|^\*\*Decision' docs/decisions/technical-decisions-phase-03-videos.md` | 12 TDs, todos com `**Decision:**` preenchido (fila, upload, storage, cliente S3, worker, FFmpeg, slug, streaming, ciclo de status, testes, cliente AMQP, retry); `status: decided` |
| 1.2 | Pasta da fase completa | `ls docs/phases/phase-03-videos/` | `context.md`, `validation.md`, `library-refs.md`, `phase-03-videos.md`, `progress.md` |
| 1.3 | `validation.md` clean | `sed -n 1,6p docs/phases/phase-03-videos/validation.md` | `status: clean`, `issue_count: 0`; `## Resolved Issues` com 8 issues (MD-1, IC-1/2, AMB-1/2/3, ICC-1/2) |
| 1.4 | Formato do plano | `grep -n '^### SI-03\|^### \(Data Model\|API Contracts\|Authorization Matrix\|Error Catalog\|Events/Messages\)\|^## ' docs/phases/phase-03-videos/phase-03-videos.md` | SI-03.1…SI-03.9; as 5 Technical Specifications; `## Dependency Map` e `## Deliverables` |
| 1.5 | Libs confirmadas via Context7 | `sed -n 1,25p docs/phases/phase-03-videos/library-refs.md` | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `amqplib`, `amqp-connection-manager` com versão e `context7_id` |
| 1.6 | Progresso por SI | `grep -n 'Status:\|Tests:' docs/phases/phase-03-videos/progress.md` | `**Status:** completed`, `9/9`, testes por SI |

## 2. Implementação — feature

| # | Critério | Como verificar | Esperado |
|---|----------|----------------|----------|
| 2.1 | Upload até 10 GB sem travar a API, com rascunho ao iniciar | `docker compose exec nestjs-api npx jest --config ./test/jest-e2e.json test/videos.e2e-spec.ts -t "POST /videos"` | `201` com `status: "draft"`, `part_count: 160` para 10 GiB, `400 VALIDATION_ERROR` para 10 GiB + 1 byte |
| 2.1b | Bytes não passam pela API (prova real) | `scripts/smoke-video-pipeline.sh .tmp-evidence/video-10gib.mp4` (arquivo de ~10 GiB, ver `docs/evidencias/README.md`) | 160 PUTs para o host do MinIO (não `:3000`); latência da API estável durante o envio |
| 2.2 | Processamento automático (duração/metadados + thumbnail) | `docker compose exec nestjs-api npx jest --config ./test/jest-e2e.json test/videos-flow.e2e-spec.ts` | vídeo vai a `ready` com `duration_seconds ≈ 2`, `metadata.video_codec = h264` e `thumbnail_url` servindo `image/jpeg` |
| 2.3 | URL única, sem conflito | `docker compose exec nestjs-api npx jest src/videos/videos.service.spec.ts -t slug` e `src/videos/entities/video.entity.integration-spec.ts` | colisão gera novo slug; índice único rejeita slug duplicado; dois uploads → slugs diferentes |
| 2.4 | Streaming sem download completo + download | `test/videos-flow.e2e-spec.ts` (acima) ou o smoke | `GET /stream` → `302`; storage responde `206` a `Range: bytes=0-1023`; `GET /download` → `302` → `Content-Disposition: attachment`, arquivo idêntico |
| 2.5 | Ciclo de status no banco | `docker compose exec db psql -U streamtube -c "select slug,status,duration_seconds,processing_error from videos order by created_at desc limit 5"` após o smoke; testes `video-processing.service.*` | `draft` → `processing` → `ready`; arquivo inválido → `failed` com motivo; 3 tentativas para falha transitória |

## 3. Implementação — infraestrutura e qualidade

| # | Critério | Como verificar | Esperado |
|---|----------|----------------|----------|
| 3.1 | Storage, fila e worker no Compose | `docker compose ps` e `docker compose logs video-worker \| grep Consuming` | `minio`, `minio-init`, `rabbitmq`, `video-worker` sobem com `docker compose up -d`; worker loga `Consuming videos.processing` |
| 3.2 | Migration e entidade ligada ao canal | `ls nestjs-project/src/database/migrations/*CreateVideos*` e `docker compose exec db psql -U streamtube -c '\d videos'` | tabela `videos` com FK `channel_id → channels(id) ON DELETE CASCADE`, `slug` único, enum de status |
| 3.3 | Testes verdes | `docker compose exec nestjs-api npm test -- --runInBand` e `docker compose exec nestjs-api npm run test:e2e` | todas as suítes passam (números em `docs/evidencias/`) |
| 3.4 | Definition of Done | `docker compose exec nestjs-api npx tsc --noEmit; echo $?` e `docker compose exec nestjs-api npm run lint` | `0` e lint sem erros |
| 3.5 | Git Flow | `git log --oneline --graph main..dev` e `git log --format='%h %s' main -1` | trabalho em `feature/phase-03-videos` (e `bugfix/baseline-test-and-lint`) mergeado em `dev`; `main` sem commits novos |

**Checagem negativa dos testes:** os testes falham quando o comportamento quebra. Exemplo: troque `VIDEO_UPLOAD.MAX_SIZE_BYTES` em `src/videos/videos.constants.ts` para `5 * 1024 ** 3` e rode `npx jest --config ./test/jest-e2e.json test/videos.e2e-spec.ts -t "10 GiB"` → falha (`expected 201, got 400`). Desfaça com `git checkout src/videos/videos.constants.ts`.

## 4. Documentação e ferramenta

| # | Critério | Como verificar | Esperado |
|---|----------|----------------|----------|
| 4.1 | CLAUDE.md com a seção de vídeos, coerente com o código | `grep -n 'Videos' CLAUDE.md nestjs-project/CLAUDE.md`; cada arquivo citado existe: `for f in $(grep -o 'src/[a-z./-]*\.ts' nestjs-project/CLAUDE.md \| sort -u); do test -f nestjs-project/$f \|\| echo FALTA $f; done` | seções presentes; nenhum `FALTA` |
| 4.2 | Ferramenta | Claude Code com a fundação original (`.claude/`, `CLAUDE.md`, `.mcp.json`) | nada a portar |

## 5. Arquivos do projeto base preservados

```bash
git diff --stat upstream/main -- next-frontend/        # frontend fora do escopo: sem mudanças
git diff --stat upstream/main -- nestjs-project/src/auth nestjs-project/src/users nestjs-project/src/mail
```

Esperado: nenhuma mudança no `next-frontend/`. Em `auth/`, `users/` e `mail/` só os ajustes de lint/testes do baseline (`bugfix/baseline-test-and-lint`): o `npm run lint` do repositório base falhava com 150 erros, e o teste de migrations falhava ou travava conforme a ordem das suítes.
