import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { readSampleVideo } from '../src/test/fixtures';
import { deleteQueueNamespace, waitFor } from '../src/test/messaging';
import { VideoProcessingModule } from '../src/videos/video-processing.module';
import {
  createUserWithToken,
  createVideosE2EApp,
  E2EContext,
  putPart,
} from './helpers/videos-e2e';

/**
 * Full pipeline: draft → direct multipart upload → complete → queue →
 * worker (ffprobe/ffmpeg) → ready → stream (206) and download. The worker
 * runs in this process on an isolated queue namespace (TD-10).
 */
// Real ffmpeg processing + polling: well above Jest's 5 s default.
jest.setTimeout(60_000);

describe('Video pipeline (e2e)', () => {
  let ctx: E2EContext;
  let token: string;
  const sample = readSampleVideo();

  beforeAll(async () => {
    // The worker feature is loaded into the same app (one DataSource); its
    // consumer starts on app.init() through onApplicationBootstrap.
    ctx = await createVideosE2EApp('videos-flow', [VideoProcessingModule]);
  });

  afterAll(async () => {
    await ctx.app.close();
    await deleteQueueNamespace(ctx.namespace);
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    ({ token } = await createUserWithToken(ctx));
  });

  const http = () => request(ctx.app.getHttpServer());
  const auth = () => `Bearer ${token}`;

  async function uploadSample(title: string): Promise<string> {
    const created = await http()
      .post('/videos')
      .set('Authorization', auth())
      .send({
        title,
        file_name: 'sample clip.mp4',
        file_size: sample.length,
        content_type: 'video/mp4',
      })
      .expect(201);
    const slug = created.body.slug as string;

    const urls = await http()
      .post(`/videos/${slug}/upload/part-urls`)
      .set('Authorization', auth())
      .send({ part_numbers: [1] })
      .expect(200);
    const etag = await putPart(urls.body.urls[0].url, sample);

    await http()
      .post(`/videos/${slug}/upload/complete`)
      .set('Authorization', auth())
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(202);
    return slug;
  }

  async function waitUntilReady(slug: string) {
    return waitFor(
      async () => {
        const res = await http()
          .get(`/videos/${slug}`)
          .set('Authorization', auth());
        return res.body.status === 'ready' ? res.body : null;
      },
      { timeoutMs: 30_000, intervalMs: 250 },
    );
  }

  it('processes an uploaded video and serves it by streaming and download', async () => {
    const slug = await uploadSample('Pipeline video');

    const video = await waitUntilReady(slug);
    expect(video.duration_seconds).toBeCloseTo(2, 0);
    expect(video.metadata).toMatchObject({
      video_codec: 'h264',
      width: 640,
      height: 360,
    });

    const thumb = await fetch(video.thumbnail_url as string);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');

    const stream = await http()
      .get(`/videos/${slug}/stream`)
      .set('Authorization', auth())
      .expect(302);
    const partial = await fetch(stream.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(
      `bytes 0-1023/${sample.length}`,
    );
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(
      sample.subarray(0, 1024),
    );

    const download = await http()
      .get(`/videos/${slug}/download`)
      .set('Authorization', auth())
      .expect(302);
    const file = await fetch(download.headers.location);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toBe(
      `attachment; filename="sample clip.mp4"; filename*=UTF-8''sample%20clip.mp4`,
    );
    expect(Buffer.from(await file.arrayBuffer())).toEqual(sample);
  });

  it('gives each upload its own slug that resolves only its video', async () => {
    const first = await uploadSample('First');
    const second = await uploadSample('Second');

    expect(first).not.toBe(second);
    const [a, b] = await Promise.all([
      waitUntilReady(first),
      waitUntilReady(second),
    ]);
    expect(a.title).toBe('First');
    expect(b.title).toBe('Second');
  });
});
