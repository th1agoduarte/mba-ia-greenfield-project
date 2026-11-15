import { NonRetryableProcessingError } from './media.errors';
import { FfprobeOutput, toProbeResult } from './media-probe.service';

const h264 = { codec_type: 'video', codec_name: 'h264', width: 640 };

function probe(format: FfprobeOutput['format'], streams = [h264]) {
  return () => toProbeResult({ format, streams });
}

describe('toProbeResult', () => {
  it('reads duration and metadata of a video', () => {
    const result = toProbeResult({
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.000000' },
      streams: [h264],
    });

    expect(result.duration_seconds).toBe(2);
    expect(result.metadata).toMatchObject({ video_codec: 'h264', width: 640 });
  });

  // ffprobe reports these images as a `video` stream (checked with ffprobe 5.1).
  it.each([
    ['png_pipe', undefined],
    ['image2', '0.040000'],
    ['jpeg_pipe', undefined],
    ['gif', '1.000000'],
    ['webp_pipe', undefined],
  ])('rejects a still image (%s) as non-retryable', (format_name, duration) => {
    expect(probe({ format_name, duration })).toThrow(
      NonRetryableProcessingError,
    );
    expect(probe({ format_name, duration })).toThrow(/still image/);
  });

  it('rejects an input without a positive duration', () => {
    expect(probe({ format_name: 'avi' })).toThrow(/no positive duration/);
    expect(probe({ format_name: 'avi', duration: '0.000000' })).toThrow(
      NonRetryableProcessingError,
    );
  });

  it('accepts a Matroska/WebM without duration (browser recording) as null', () => {
    const result = toProbeResult({
      format: { format_name: 'matroska,webm' },
      streams: [{ codec_type: 'video', codec_name: 'vp8' }],
    });

    expect(result.duration_seconds).toBeNull();
  });

  it('rejects an input without a video stream', () => {
    expect(
      probe({ format_name: 'ogg', duration: '3.0' }, [
        { codec_type: 'audio', codec_name: 'vorbis', width: 0 },
      ]),
    ).toThrow(/no video stream/);
  });
});
