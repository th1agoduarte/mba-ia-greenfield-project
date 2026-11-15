import { randomBytes } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { deleteQueueNamespace } from '../src/test/messaging';
import { User } from '../src/users/entities/user.entity';
import {
  createUserWithToken,
  createVideosE2EApp,
  E2EContext,
  putPart,
} from './helpers/videos-e2e';

const validBody = {
  title: 'My first video',
  file_name: 'clip.mp4',
  file_size: 150 * 1024 * 1024,
  content_type: 'video/mp4',
};

describe('Videos (e2e)', () => {
  let ctx: E2EContext;
  let token: string;
  let otherToken: string;

  beforeAll(async () => {
    ctx = await createVideosE2EApp('videos-e2e');
  });

  afterAll(async () => {
    await ctx.app.close();
    await deleteQueueNamespace(ctx.namespace);
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    ({ token } = await createUserWithToken(ctx));
    ({ token: otherToken } = await createUserWithToken(ctx));
  });

  const http = () => request(ctx.app.getHttpServer());

  async function createDraft(body = validBody) {
    const res = await http()
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    return res.body as { slug: string; id: string };
  }

  describe('POST /videos', () => {
    it('creates a draft with an 11-char slug and the upload instructions', async () => {
      const res = await http()
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody)
        .expect(201);

      expect(res.body).toMatchObject({
        title: 'My first video',
        status: 'draft',
        upload: {
          part_size: 67108864,
          part_count: 3,
          max_urls_per_request: 100,
        },
      });
      expect(res.body.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      const [row] = await ctx.dataSource.query(
        'SELECT status, upload_id FROM videos WHERE id = $1',
        [res.body.id],
      );
      expect(row.status).toBe('draft');
      expect(row.upload_id).toBeTruthy();
    });

    it('accepts exactly 10 GiB and rejects anything larger', async () => {
      await http()
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...validBody, file_size: 10737418240 })
        .expect(201)
        .expect((res) => expect(res.body.upload.part_count).toBe(160));

      const res = await http()
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...validBody, file_size: 10737418241 })
        .expect(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('rejects a non-video content type', async () => {
      const res = await http()
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...validBody, content_type: 'image/png' })
        .expect(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('requires authentication', async () => {
      await http().post('/videos').send(validBody).expect(401);
    });

    it('answers 404 CHANNEL_NOT_FOUND to a user without a channel', async () => {
      const email = `nochannel_${randomBytes(4).toString('hex')}@example.com`;
      const user = await ctx.dataSource
        .getRepository(User)
        .save({ email, password: 'not-used', is_confirmed: true });
      const noChannelToken = ctx.module
        .get(JwtService)
        .sign({ sub: user.id, email });

      const res = await http()
        .post('/videos')
        .set('Authorization', `Bearer ${noChannelToken}`)
        .send(validBody)
        .expect(404);

      expect(res.body.error).toBe('CHANNEL_NOT_FOUND');
    });

    it('gives two videos different slugs', async () => {
      const a = await createDraft();
      const b = await createDraft();
      expect(a.slug).not.toBe(b.slug);
    });
  });

  describe('upload parts', () => {
    it('signs part URLs on the storage, lists stored parts and resumes', async () => {
      // Two parts: 64 MiB + 1 KiB (each URL is signed for its exact size).
      const { slug } = await createDraft({
        ...validBody,
        file_size: 64 * 1024 * 1024 + 1024,
      });

      const urls = await http()
        .post(`/videos/${slug}/upload/part-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [1, 2] })
        .expect(200);
      expect(urls.body.expires_in).toBe(3600);
      expect(urls.body.urls).toHaveLength(2);
      const url1 = new URL(urls.body.urls[0].url as string);
      expect(url1.host).toBe(new URL(process.env.S3_ENDPOINT!).host);
      expect(url1.searchParams.get('partNumber')).toBe('1');

      const etag = await putPart(urls.body.urls[1].url, randomBytes(1024));

      const parts = await http()
        .get(`/videos/${slug}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(parts.body.parts).toEqual([{ part_number: 2, etag, size: 1024 }]);
    });

    it('rejects a part number beyond the part count', async () => {
      const { slug } = await createDraft();
      const res = await http()
        .post(`/videos/${slug}/upload/part-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [4] })
        .expect(400);
      expect(res.body.error).toBe('INVALID_PART_NUMBER');
    });

    it('validates part_numbers', async () => {
      const { slug } = await createDraft();
      const res = await http()
        .post(`/videos/${slug}/upload/part-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [] })
        .expect(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('cancels the upload and removes the draft', async () => {
      const { slug, id } = await createDraft();

      await http()
        .delete(`/videos/${slug}/upload`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const rows = await ctx.dataSource.query(
        'SELECT 1 FROM videos WHERE id = $1',
        [id],
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('ownership', () => {
    it('answers 404 VIDEO_NOT_FOUND to another user on every upload route', async () => {
      const { slug } = await createDraft();
      const auth = `Bearer ${otherToken}`;

      const responses = await Promise.all([
        http()
          .post(`/videos/${slug}/upload/part-urls`)
          .set('Authorization', auth)
          .send({ part_numbers: [1] }),
        http().get(`/videos/${slug}/upload/parts`).set('Authorization', auth),
        http().delete(`/videos/${slug}/upload`).set('Authorization', auth),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('VIDEO_NOT_FOUND');
      }
    });
  });

  describe('POST /videos/:slug/upload/complete', () => {
    async function uploadedDraft() {
      const { slug, id } = await createDraft({ ...validBody, file_size: 4096 });
      const urls = await http()
        .post(`/videos/${slug}/upload/part-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [1] })
        .expect(200);
      const etag = await putPart(urls.body.urls[0].url, randomBytes(4096));
      return { slug, id, etag };
    }

    it('completes the upload and answers 202 processing (idempotent)', async () => {
      const { slug, etag } = await uploadedDraft();

      for (let i = 0; i < 2; i++) {
        const res = await http()
          .post(`/videos/${slug}/upload/complete`)
          .set('Authorization', `Bearer ${token}`)
          .send({ parts: [{ part_number: 1, etag }] })
          .expect(202);
        expect(res.body).toMatchObject({ slug, status: 'processing' });
      }
    });

    it('rejects parts the storage does not know with INVALID_UPLOAD_PARTS', async () => {
      const { slug, id } = await uploadedDraft();

      const res = await http()
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          parts: [
            { part_number: 1, etag: '"0123456789abcdef0123456789abcdef"' },
          ],
        })
        .expect(400);

      expect(res.body.error).toBe('INVALID_UPLOAD_PARTS');
      const [row] = await ctx.dataSource.query(
        'SELECT status FROM videos WHERE id = $1',
        [id],
      );
      expect(row.status).toBe('draft');
    });

    it('validates the parts list', async () => {
      const { slug } = await createDraft();
      const res = await http()
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 0, etag: '' }] })
        .expect(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('answers 404 to another user', async () => {
      const { slug, etag } = await uploadedDraft();
      await http()
        .post(`/videos/${slug}/upload/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(404);
    });
  });

  describe('GET /videos/:slug, stream and download before processing', () => {
    it('returns the draft details to the owner and 404 to others', async () => {
      const { slug } = await createDraft();

      const res = await http()
        .get(`/videos/${slug}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body).toMatchObject({
        slug,
        status: 'draft',
        original_file_name: 'clip.mp4',
        size_bytes: validBody.file_size,
        duration_seconds: null,
        thumbnail_url: null,
      });

      await http()
        .get(`/videos/${slug}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
    });

    it('answers 409 VIDEO_NOT_READY to stream and download of a video not ready', async () => {
      const { slug } = await createDraft();
      for (const route of ['stream', 'download']) {
        const res = await http()
          .get(`/videos/${slug}/${route}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(409);
        expect(res.body.error).toBe('VIDEO_NOT_READY');
      }
    });

    it('answers 404 for an unknown slug', async () => {
      await http()
        .get('/videos/doesnotexis/stream')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });
});
