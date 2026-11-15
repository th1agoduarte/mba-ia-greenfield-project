import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { readSampleVideo } from '../test/fixtures';
import { useInternalStorageEndpointForTests } from '../test/storage';
import { NonRetryableProcessingError } from './media.errors';
import { MediaModule } from './media.module';
import { MediaProbeService } from './media-probe.service';

/** Width/height from the JPEG start-of-frame (SOF0..SOF2) segment. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < buf.length) {
    const marker = buf.readUInt16BE(offset);
    const length = buf.readUInt16BE(offset + 2);
    if (marker >= 0xffc0 && marker <= 0xffc2) {
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error('No SOF segment found');
}

describe('MediaProbeService (integration — ffmpeg + MinIO)', () => {
  let module: TestingModule;
  let media: MediaProbeService;
  let storage: StorageService;

  beforeAll(async () => {
    useInternalStorageEndpointForTests();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
        MediaModule,
      ],
    }).compile();
    media = module.get(MediaProbeService);
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await module.close();
  });

  async function presignedSample(body: Buffer): Promise<string> {
    const key = `test/${randomUUID()}/original`;
    await storage.putObject(key, body, 'video/mp4');
    return storage.presignGetObject(key, { internal: true });
  }

  it('reads duration and metadata over a presigned URL', async () => {
    const url = await presignedSample(readSampleVideo());

    const result = await media.probe(url);

    expect(result.duration_seconds).toBeCloseTo(2, 0);
    expect(result.metadata).toMatchObject({
      video_codec: 'h264',
      audio_codec: 'aac',
      width: 640,
      height: 360,
      frame_rate: 25,
    });
    expect(result.metadata.format_name).toContain('mp4');
  });

  it('extracts a 1280 px wide JPEG frame', async () => {
    const url = await presignedSample(readSampleVideo());

    const jpeg = await media.extractFrame(url, 0.2);

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpegSize(jpeg)).toEqual({ width: 1280, height: 720 });
  });

  it('rejects a file that is not a video as non-retryable', async () => {
    const url = await presignedSample(Buffer.from('definitely not a video'));

    await expect(media.probe(url)).rejects.toBeInstanceOf(
      NonRetryableProcessingError,
    );
  });

  it('treats a missing object as non-retryable', async () => {
    const url = await storage.presignGetObject(`test/${randomUUID()}/missing`, {
      internal: true,
    });

    await expect(media.probe(url)).rejects.toBeInstanceOf(
      NonRetryableProcessingError,
    );
  });

  it.each([
    ['PNG', 'png'],
    ['JPEG', 'mjpeg'],
    ['GIF', 'gif'],
  ])('rejects a still %s image as non-retryable', async (_name, codec) => {
    const image = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240',
        '-frames:v',
        '1',
        '-c:v',
        codec,
        '-f',
        'image2pipe',
        'pipe:1',
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const url = await presignedSample(image);

    await expect(media.probe(url)).rejects.toBeInstanceOf(
      NonRetryableProcessingError,
    );
  });

  describe('refuses playlists and non-HTTP inputs (no requests to internal URLs)', () => {
    // Without the format whitelist ffprobe opens these manifests and requests
    // the segment URL they point to (checked with ffprobe 5.1 of the image).
    const hls = Buffer.from(
      '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://db:5432/segment.ts\n#EXT-X-ENDLIST\n',
    );
    const dash = Buffer.from(
      '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT10S" minBufferTime="PT1S">' +
        '<Period><AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1000" width="64" height="64" codecs="avc1.42c00a">' +
        '<BaseURL>http://db:5432/segment.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>\n',
    );

    it.each([
      ['an HLS playlist', hls],
      ['a DASH manifest', dash],
    ])(
      'rejects %s as non-retryable in probe and thumbnail',
      async (_name, body) => {
        const url = await presignedSample(body);

        for (const run of [
          () => media.probe(url),
          () => media.extractFrame(url, 0),
        ]) {
          const err = await run().catch((e: Error) => e);
          expect(err).toBeInstanceOf(NonRetryableProcessingError);
          expect((err as Error).message).toContain('not on whitelist');
        }
      },
    );

    it('rejects a local file input (protocol whitelist)', async () => {
      const err = await media.probe('file:///etc/hostname').catch((e) => e);

      expect(err).toBeInstanceOf(NonRetryableProcessingError);
      expect((err as Error).message).toContain('not on whitelist');
    });
  });

  it('accepts a WebM without container duration (browser recording style)', async () => {
    // Writing WebM to a pipe leaves no duration in the header, like MediaRecorder output.
    const webm = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=320x240:rate=10',
        '-c:v',
        'libvpx',
        '-deadline',
        'realtime',
        '-f',
        'webm',
        'pipe:1',
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const url = await presignedSample(webm);

    const result = await media.probe(url);

    expect(result.metadata.video_codec).toBe('vp8');
    expect(
      result.duration_seconds === null || result.duration_seconds > 0,
    ).toBe(true);
    const frame = await media.extractFrame(url, 0);
    expect(frame.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});
