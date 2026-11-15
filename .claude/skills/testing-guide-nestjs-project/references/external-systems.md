> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real MinIO (Docker)

**Strategy:** Real S3-compatible storage — the `minio` service in `compose.yaml` (bucket created by the one-shot `minio-init`). S3 in production; same API (decided in `phase-03-videos/TD-03`, `TD-10`).

**Approach:**
- `StorageService` (`src/storage/`) talks to MinIO through the AWS SDK v3 — no local-filesystem adapter, no mocks in integration/e2e tests
- Presigned URLs embed the host they were signed for. Tests run inside the Compose network, so call `useInternalStorageEndpointForTests()` (`src/test/storage.ts`) **before** compiling the module: it signs for `S3_ENDPOINT` (`http://minio:9000`) instead of the host-facing `S3_PUBLIC_ENDPOINT`
- Use unique keys per test (`test/<uuid>/...`) instead of cleaning the bucket
- Video fixtures: `test/fixtures/sample.mp4` (2 s, H.264 + AAC) via `readSampleVideo()` (`src/test/fixtures.ts`)

**Integration test:**

```typescript
beforeAll(async () => {
  useInternalStorageEndpointForTests();
  module = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }), StorageModule],
  }).compile();
  storage = module.get(StorageService);
});

it('serves a presigned GET with Range as 206', async () => {
  const key = `test/${randomUUID()}/original`;
  await storage.putObject(key, body, 'video/mp4');
  const res = await fetch(await storage.presignGetObject(key), { headers: { Range: 'bytes=0-99' } });
  expect(res.status).toBe(206);
});
```

---

## Message Queue — Real RabbitMQ (Docker)

**Strategy:** Real broker — the `rabbitmq` service in `compose.yaml` (decided in `phase-03-videos/TD-01`, `TD-11`, `TD-12`).

**Test isolation:**
- The long-running `video-worker` container consumes the default namespace (`RABBITMQ_NAMESPACE=videos`). Tests must never publish there: call `useIsolatedQueueNamespaceForTests(label)` (`src/test/messaging.ts`) **before** compiling the module — it sets a throwaway namespace and a short retry TTL — and `deleteQueueNamespace(namespace)` in `afterAll`
- For publisher tests: `drainQueue(videoProcessingTopology(ns).queue)` and assert the message body/headers
- For consumer tests: start the consumer with a handler, publish, and `waitFor(...)` the outcome
- E2E of the whole pipeline: load `VideoProcessingModule` into the same app as `AppModule` (`createVideosE2EApp(label, [VideoProcessingModule])` in `test/helpers/videos-e2e.ts`) — two TypeORM roots in one process break the default DataSource

**Setup pattern:**

```typescript
beforeEach(async () => {
  namespace = useIsolatedQueueNamespaceForTests('messaging');
  module = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, load: [messagingConfig] }), MessagingModule],
  }).compile();
});

afterEach(async () => {
  await module.close();
  await deleteQueueNamespace(namespace);
});
```

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
