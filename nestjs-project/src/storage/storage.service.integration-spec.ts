import { randomBytes, randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { InvalidUploadPartsException } from '../common/exceptions/domain.exception';
import { useInternalStorageEndpointForTests } from '../test/storage';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const FIVE_MIB = 5 * 1024 * 1024;

async function putPart(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  expect(res.status).toBe(200);
  const etag = res.headers.get('etag');
  expect(etag).toBeTruthy();
  return etag!;
}

describe('StorageService (integration — MinIO)', () => {
  let module: TestingModule;
  let storage: StorageService;

  beforeAll(async () => {
    useInternalStorageEndpointForTests();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await module.close();
  });

  function newKey(): string {
    return `test/${randomUUID()}/original`;
  }

  it('uploads a file in two parts through presigned URLs and completes it', async () => {
    const key = newKey();
    const part1 = randomBytes(FIVE_MIB);
    const part2 = randomBytes(1024);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const etag1 = await putPart(
      await storage.presignUploadPart(key, uploadId, 1, part1.length),
      part1,
    );
    const etag2 = await putPart(
      await storage.presignUploadPart(key, uploadId, 2, part2.length),
      part2,
    );

    const listed = await storage.listParts(key, uploadId);
    expect(listed.map((p) => p.part_number)).toEqual([1, 2]);
    expect(listed[0].size).toBe(FIVE_MIB);

    await storage.completeMultipartUpload(key, uploadId, [
      { part_number: 2, etag: etag2 },
      { part_number: 1, etag: etag1 },
    ]);

    const head = await storage.headObject(key);
    expect(head?.contentLength).toBe(FIVE_MIB + 1024);
    expect(head?.contentType).toBe('video/mp4');
  });

  it('signs the part size: the storage refuses a PUT larger or smaller than signed', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(key, uploadId, 1, 1024);
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toContain(
      'content-length',
    );

    for (const size of [1025, 1023]) {
      const res = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(size)),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('SignatureDoesNotMatch');
    }
    expect(await storage.listParts(key, uploadId)).toEqual([]);

    await putPart(url, randomBytes(1024));
    expect(await storage.listParts(key, uploadId)).toMatchObject([
      { part_number: 1, size: 1024 },
    ]);
    await storage.abortMultipartUpload(key, uploadId);
  });

  it('serves a presigned GET with Range as 206 Partial Content', async () => {
    const key = newKey();
    const body = randomBytes(4096);
    await storage.putObject(key, body, 'video/mp4');

    const res = await fetch(await storage.presignGetObject(key), {
      headers: { Range: 'bytes=0-99' },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/4096');
    const chunk = Buffer.from(await res.arrayBuffer());
    expect(chunk).toEqual(body.subarray(0, 100));
  });

  it('adds an attachment Content-Disposition to download URLs', async () => {
    const key = newKey();
    await storage.putObject(key, randomBytes(10), 'video/mp4');

    const res = await fetch(
      await storage.presignGetObject(key, {
        downloadFileName: 'my "clip".mp4',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="my _clip_.mp4"',
    );
  });

  it('rejects a completion with a wrong ETag as INVALID_UPLOAD_PARTS', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await putPart(
      await storage.presignUploadPart(key, uploadId, 1, 10),
      randomBytes(10),
    );

    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { part_number: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(InvalidUploadPartsException);

    await storage.abortMultipartUpload(key, uploadId);
  });

  it('returns null from headObject for a missing object', async () => {
    await expect(storage.headObject(newKey())).resolves.toBeNull();
  });
});
