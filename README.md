# StreamTube — Plataforma de Compartilhamento de Vídeos

Projeto da disciplina **Desenvolvimento de Aplicações de IA** do MBA de Engenharia de Software com IA da [Full Cycle](https://fullcycle.com.br).

Este é um projeto greenfield desenvolvido para demonstrar como construir uma aplicação do zero utilizando IA de forma adequada no processo de desenvolvimento.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>

---

## Quadro Branco

- [Quadro Branco](./whiteboard.png)

---

## 🎨 Design System (Figma)

- [FC Tube.fig](./FC%20Tube.fig) — arquivo-fonte do **design system** do projeto no Figma.
- [FC Tube sem padrão.fig](./FC%20Tube%20sem%20padrao.fig) — arquivo-fonte puro, sem tokens, cores, tipografia e espaçamento.

Contém os fundamentos visuais do StreamTube — tokens (cores, tipografia, espaçamento, raios), componentes e as telas da plataforma. É a referência de design para a implementação do frontend: os componentes em `next-frontend/components/ui` (shadcn) e os tokens em `next-frontend/app/globals.css` derivam deste arquivo. Abra-o no Figma (`Arquivo → Importar`) para consultar especificações e estados visuais.

---

## 📋 Pré-requisitos

- Docker e Docker Compose
- Node.js v25+ (para rodar os testes E2E do Playwright no host)
- npm

## 🏗️ Arquitetura

O projeto é um monorepo baseado em containers Docker. Cada subprojeto sobe sua própria stack via `docker compose`.

- **Frontend** (Next.js 16, App Router + React Server Components) — interface da plataforma. Segue o **modelo BFF**: o navegador nunca chama a API NestJS diretamente; todo tráfego passa por Route Handlers same-origin em `app/api/**`, que fazem proxy server-side para a API.
- **API** (NestJS 11) — regras de negócio, autenticação (JWT + refresh token rotation), envio de e-mails e acesso ao banco.
- **Database** (PostgreSQL 17) — usuários, canais e tokens de autenticação.
- **Email Service** (Mailpit) — captura os e-mails transacionais (confirmação de conta e recuperação de senha) em uma UI local.
- **Video Worker** (FFmpeg) — processamento de vídeos: container `video-worker` (`nestjs-project/src/worker.ts`) que consome a fila, extrai duração/metadados com `ffprobe` e gera a thumbnail com `ffmpeg` *(Fase 03)*.
- **Object Storage** (S3/MinIO) — arquivos de vídeo e thumbnails num bucket privado; o cliente envia e assiste direto no storage por URLs pré-assinadas *(Fase 03)*.
- **Message Queue** (RabbitMQ) — fila de processamento de vídeos com retry (3 tentativas) e fila de estacionamento *(Fase 03)*.

O diagrama de arquitetura completo (C4) está em `docs/diagrams/software-arch.mermaid`.

## 🚀 Como rodar

Os dois subprojetos têm stacks Docker **separadas**. Suba primeiro o backend, rode as migrations e depois o frontend.

### 1. Backend (NestJS + PostgreSQL + Mailpit)

```bash
cd nestjs-project

# Sobe API, banco, Mailpit, MinIO (+ criação do bucket), RabbitMQ e o video-worker
docker compose up -d

# Instala dependências (apenas na primeira vez)
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe o servidor de desenvolvimento em watch mode
docker compose exec -d nestjs-api npm run start:dev
```

Serviços disponíveis:

| Serviço | URL / Porta |
|---------|-------------|
| API NestJS | http://localhost:3000 |
| PostgreSQL | `localhost:5432` (db/user/senha: `streamtube`) |
| Mailpit (UI de e-mails) | http://localhost:8025 |
| MinIO (API S3 / console) | http://localhost:9000 / http://localhost:9001 (usuário/senha `S3_ACCESS_KEY`/`S3_SECRET_KEY` do `.env`) |
| RabbitMQ (AMQP / painel) | `localhost:5672` / http://localhost:15672 (`streamtube`/`streamtube`) |
| Video worker | sem porta — `docker compose logs -f video-worker` |
| Swagger (opcional) | http://localhost:3000/api/docs — habilite com `SWAGGER_ENABLED=true` |

> Se alguma porta do host estiver ocupada, troque `MINIO_API_PORT`, `MINIO_CONSOLE_PORT`, `RABBITMQ_PORT` ou `RABBITMQ_MANAGEMENT_PORT` no `.env` — e mantenha `S3_PUBLIC_ENDPOINT` igual à porta publicada do MinIO, porque as URLs pré-assinadas são assinadas para esse host.

### 2. Frontend (Next.js)

```bash
cd next-frontend

# Garanta que o .env.local existe (veja .env.example)
# API_URL aponta para o backend; SESSION_PASSWORD protege a sessão (iron-session)

docker compose up -d
docker compose exec next-frontend npm install        # apenas na primeira vez
docker compose exec -d next-frontend npm run dev
```

A aplicação ficará disponível em **http://localhost:3001**.

> As stacks são separadas, então o frontend acessa o backend via `host.docker.internal:3000` (configurado em `next-frontend/.env.local` e no `extra_hosts` do compose).

## 🧪 Testes

### Backend (Jest)

```bash
cd nestjs-project
docker compose exec nestjs-api npm test               # unitários + integração (em band)
docker compose exec nestjs-api npm run test:e2e       # end-to-end (HTTP via supertest)
docker compose exec nestjs-api npm run test:cov       # cobertura
```

Sufixos: `*.spec.ts` (unitário), `*.integration-spec.ts` (integração com banco real), `*.e2e-spec.ts` (end-to-end). Testes de integração/e2e rodam com `--runInBand`.

### Frontend (Vitest + Playwright)

```bash
cd next-frontend
docker compose exec next-frontend npm test            # unitários + integração (Vitest + MSW)
npx playwright test                                   # end-to-end (no host, com dev server em MSW_ENABLED=true)
```

Sufixos: `*.test.ts(x)` (unitário), `*.integration.test.ts(x)` (Route Handlers com MSW), `*.e2e-spec.ts` (Playwright). MSW intercepta as chamadas à API NestJS — os testes nunca batem no backend real.

## ✅ Funcionalidades implementadas

**Fase 01 — Configuração base** e **Fase 02 — Autenticação** estão concluídas (backend + frontend). **Fase 03 — Upload e Processamento de Vídeos** está concluída no backend.

### Vídeos (Fase 03)

Upload de até **10 GiB** sem passar pela API, processamento automático em fila, thumbnail, URL única, streaming e download:

1. `POST /videos` pré-cadastra o vídeo como **rascunho** (`draft`), gera o **slug único** (11 caracteres base64url) e abre um upload multipart no storage.
2. O cliente pede URLs pré-assinadas (`POST /videos/{slug}/upload/part-urls`) e envia partes de 64 MiB **direto ao MinIO/S3**; `GET /videos/{slug}/upload/parts` permite retomar um upload interrompido.
3. `POST /videos/{slug}/upload/complete` fecha o multipart, muda para **processando** (`processing`) e publica `video.uploaded` no RabbitMQ.
4. O `video-worker` lê o arquivo por URL pré-assinada (só os trechos necessários), extrai duração e metadados (`ffprobe`), gera a thumbnail em 10% da duração (`ffmpeg`) e marca **pronto** (`ready`). Falhas transitórias têm 3 tentativas com 5 s de intervalo; depois disso, ou se o arquivo não for vídeo, o status vira **erro** (`failed`) com o motivo.
5. `GET /videos/{slug}/stream` e `GET /videos/{slug}/download` respondem `302` para URLs pré-assinadas: o storage atende `Range` com `206 Partial Content` (streaming sem baixar tudo) e o download vem como anexo.

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /videos` | Inicia o upload: cria o rascunho e o multipart (`file_size` ≤ 10 GiB) |
| `POST /videos/{slug}/upload/part-urls` | URLs pré-assinadas (1 h) para até 100 partes |
| `GET /videos/{slug}/upload/parts` | Partes já enviadas (retomada) |
| `POST /videos/{slug}/upload/complete` | Conclui o upload e dispara o processamento (idempotente) |
| `DELETE /videos/{slug}/upload` | Cancela o upload e remove o rascunho |
| `GET /videos/{slug}` | Status, duração, metadados e URL da thumbnail |
| `GET /videos/{slug}/stream` | `302` para o streaming (Range/206) |
| `GET /videos/{slug}/download` | `302` para o download (anexo) |

Todas as rotas de vídeo exigem JWT e são restritas ao dono nesta fase (outro usuário recebe `404 VIDEO_NOT_FOUND`); visibilidade e acesso anônimo ficam para as Fases 04/05.

Verificação ponta a ponta pelo container do worker (do host, com a API rodando): `cd nestjs-project && scripts/smoke-video-pipeline.sh [arquivo]`. Evidências em [`docs/evidencias/`](docs/evidencias/README.md).

### Autenticação (Fase 02)

Fluxo completo de **cadastro → confirmação por e-mail → login → recuperação de senha**, com canal criado automaticamente para cada usuário (a partir do prefixo do e-mail).

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /auth/register` | Cadastro de usuário (cria usuário + canal) |
| `GET /auth/confirm-email?token=` | Confirmação de conta via link do e-mail |
| `POST /auth/resend-confirmation` | Reenvio do e-mail de confirmação |
| `POST /auth/login` | Login (retorna access + refresh token) |
| `POST /auth/refresh` | Rotação de refresh token (com family + grace period) |
| `POST /auth/logout` | Revoga os refresh tokens da sessão |
| `POST /auth/forgot-password` | Solicita e-mail de recuperação de senha |
| `POST /auth/reset-password` | Redefine a senha via token |
| `GET /auth/me` | Dados do usuário autenticado (protegido por JWT) |

Telas e Route Handlers BFF (`next-frontend`):

- `/(auth)/signup`, `/(auth)/login`, `/(auth)/forgot-password` — formulários com React Hook Form + Zod e validação inline.
- `app/api/auth/{signup,login,logout,forgot-password}` — proxy same-origin para a API.

Segurança: senhas com **Argon2**, **JWT** com `JwtAuthGuard` global (opt-out via `@Public()`), **rotação de refresh token** com detecção de reuso, **rate limiting** (`ThrottlerGuard`) nos endpoints de auth, e sessão no navegador via **iron-session** (cookies HTTP-only).

## 🤖 Fase 03 com IA (Claude Code)

A fase foi conduzida com o Claude Code usando a fundação de IA do repositório (skills, sub-agents, rules, `CLAUDE.md`), sem portar para outra ferramenta. O encadeamento e os artefatos:

| Etapa (skill) | Artefato |
|---------------|----------|
| `research` | [`docs/decisions/technical-decisions-phase-03-videos.md`](docs/decisions/technical-decisions-phase-03-videos.md) — 12 TDs (fila RabbitMQ, upload multipart pré-assinado, storage, worker, FFmpeg, slug, streaming, ciclo de status, testes, cliente AMQP, retry) |
| `plan-context` | [`docs/phases/phase-03-videos/context.md`](docs/phases/phase-03-videos/context.md) |
| `plan-validate` ↔ `plan-resolve` | [`validation.md`](docs/phases/phase-03-videos/validation.md) — 4 execuções do validate (dirty → MD-1 fechado por um research complementar → AMB-3 → clean), 8 issues resolvidos e listados em `Resolved Issues`, **status clean**; [`library-refs.md`](docs/phases/phase-03-videos/library-refs.md) com a doc das libs via Context7 |
| `plan-build` | [`phase-03-videos.md`](docs/phases/phase-03-videos/phase-03-videos.md) — SI-03.1…SI-03.9, Technical Specifications (Data Model, API Contracts, Authorization Matrix, Error Catalog, Events/Messages), Dependency Map, Deliverables |
| `implement` | Código em `nestjs-project/` + [`progress.md`](docs/phases/phase-03-videos/progress.md) (status, testes e observações por SI) |
| Revisão | `/code-review` (nível high) + auditoria independente dos critérios do DESAFIO; correções em `bugfix/phase-03-code-review` e no SI-03.10 do plano |

Documentação das libs: o Context7 foi consultado pela API HTTP pública dele (mesmo índice do MCP), porque o `.mcp.json` do repositório base não trazia o servidor `context7` — ele foi adicionado ao `.mcp.json` nesta fase. `amqp-connection-manager` não está indexado no Context7; a referência veio do README publicado no npm (registrado em `library-refs.md`).

Baseline: o `npm run lint` do repositório base falhava com 150 erros, quase todos `no-unsafe-*`/`unbound-method` em mocks de testes. A correção (`bugfix/baseline-test-and-lint`) desliga essas regras **só em arquivos de teste** (`eslint.config.mjs`) e corrige os erros de código de produção; o código de produção segue com o conjunto completo de regras.

O passo a passo para conferir cada critério do desafio está em [`VALIDACAO.md`](VALIDACAO.md); o enunciado está em [`DESAFIO.md`](DESAFIO.md).

## 🛠️ Estrutura do Projeto

```
green-field-ia-project/
├── docs/
│   ├── project-plan.md                  # Planejamento geral do projeto
│   ├── phases/                          # Planos e implementação por fase
│   │   ├── phase-01-configuracao-base/
│   │   ├── phase-02-auth/               # Auth (backend)
│   │   ├── phase-03-videos/             # Vídeos: context, validation, library-refs, plano, progress
│   │   └── phase-02-auth-frontend/      # Auth (frontend)
│   └── diagrams/
│       └── software-arch.mermaid        # Diagrama de arquitetura (C4)
├── nestjs-project/                      # Backend API (NestJS 11)
│   ├── src/
│   │   ├── auth/                        # Cadastro, login, JWT, refresh, reset de senha
│   │   ├── users/                       # Entidade e serviço de usuários
│   │   ├── channels/                    # Canal 1:1 por usuário (nickname do e-mail)
│   │   ├── mail/                        # Envio de e-mails (templates Handlebars)
│   │   ├── videos/                      # Upload, status, streaming/download e processamento (Fase 03)
│   │   ├── storage/                     # Object storage S3/MinIO (multipart, URLs pré-assinadas)
│   │   ├── messaging/                   # RabbitMQ: topologia, publisher e consumer com retry
│   │   ├── media/                       # ffprobe/ffmpeg (metadados e thumbnail)
│   │   ├── worker.ts                    # Entrypoint do video-worker
│   │   ├── common/                      # Filtros, pipes e exceptions de domínio
│   │   ├── config/                      # Configs namespaced (Joi)
│   │   └── database/                    # data-source, migrations e seeds
│   ├── test/                            # Testes e2e
│   ├── compose.yaml                     # Docker Compose (API + PostgreSQL + Mailpit + MinIO + RabbitMQ + video-worker)
│   ├── scripts/smoke-video-pipeline.sh  # Smoke do pipeline de vídeo pelo container do worker
│   └── Dockerfile.dev
├── next-frontend/                       # Frontend (Next.js 16, App Router)
│   ├── app/                             # Rotas, layouts, páginas e Route Handlers BFF
│   ├── components/                      # Componentes de auth, UI (shadcn) e ícones
│   ├── lib/                             # env, api (openapi-fetch), auth/session
│   ├── mocks/                           # MSW (handlers + server)
│   ├── tests/                           # E2E (Playwright)
│   ├── compose.yaml                     # Docker Compose (dev server)
│   └── Dockerfile.dev
├── CLAUDE.md                            # Instruções para IA
├── FC Tube.fig                          # Design system do projeto (Figma)
├── whiteboard.png                       # Quadro branco do projeto
└── README.md
```

## 📚 Fases do Projeto

| Fase | Descrição | Status |
|------|-----------|--------|
| **01** | Configuração Base do Projeto | ✅ Concluída |
| **02** | Cadastro, Login e Gerenciamento de Conta | ✅ Concluída |
| **03** | Upload e Processamento de Vídeos | ✅ Concluída (backend) |
| **04** | Gerenciamento de Vídeos e Canal | ⏳ Planejada |
| **05** | Página de Visualização do Vídeo | ⏳ Planejada |
| **06** | Interações Sociais (Likes, Comentários, Inscrições) | ⏳ Planejada |
| **07** | Página Inicial, Busca e Finalização | ⏳ Planejada |

Detalhes completos em `docs/project-plan.md`.

## 📖 Stack Tecnológica

| Camada | Tecnologia |
|--------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, React Hook Form + Zod, iron-session, openapi-fetch |
| Backend | NestJS 11, TypeScript, TypeORM, JWT, Argon2, Mailer (Handlebars), AWS SDK v3 (S3), amqplib + amqp-connection-manager, FFmpeg |
| Storage e fila | MinIO (S3-compatible), RabbitMQ 4.2 |
| Banco de Dados | PostgreSQL 17 |
| E-mail (dev) | Mailpit |
| Containerização | Docker, Docker Compose |
| Testes | Jest, Supertest (backend); Vitest, MSW, Playwright (frontend) |
| Qualidade | ESLint, Prettier |
</content>
