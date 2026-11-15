import { readFileSync } from 'fs';
import { join } from 'path';

/** 2-second H.264/AAC 640x360 clip generated with `ffmpeg -f lavfi testsrc`. */
export const SAMPLE_VIDEO_PATH = join(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'sample.mp4',
);

export function readSampleVideo(): Buffer {
  return readFileSync(SAMPLE_VIDEO_PATH);
}
