import { spawn } from 'child_process';
import { Injectable } from '@nestjs/common';
import type { VideoMetadata } from '../videos/entities/video.entity';
import { NonRetryableProcessingError } from './media.errors';
import type { ProbeResult } from './media.types';

const PROCESS_TIMEOUT_MS = 120_000;
const THUMBNAIL_WIDTH = 1280;

/**
 * Demuxers of the common video containers (names as `ffprobe -demuxers`
 * lists them). Playlists (`hls`, `dash`), `concat` scripts and image demuxers
 * are refused before they open anything, so an uploaded manifest cannot make
 * the worker fetch internal URLs (blind SSRF).
 */
const FORMAT_WHITELIST =
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,flv,mpegts,mpeg,ogg,asf';

/** The input is always a presigned HTTP(S) URL of the object storage. */
const PROTOCOL_WHITELIST = 'http,https,tcp,tls';

/** Input options shared by ffprobe and ffmpeg (they must precede the input). */
const INPUT_GUARDS = [
  '-format_whitelist',
  FORMAT_WHITELIST,
  '-protocol_whitelist',
  PROTOCOL_WHITELIST,
];

/** stderr fragments that mean "this input will never work" (TD-06). */
const NON_RETRYABLE_STDERR = [
  'Invalid data found when processing input',
  'moov atom not found',
  '404 Not Found',
  '403 Forbidden',
  'not on whitelist',
];

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; bit_rate?: string };
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
}

function toNumber(value: string | number | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return null; // ffprobe reports '0/0' when unknown
  return Math.round((num / den) * 1000) / 1000;
}

/**
 * Runs the FFmpeg CLI directly (no wrapper — fluent-ffmpeg is deprecated)
 * against a presigned URL, so only the needed byte ranges are read
 * (phase-03-videos/TD-06).
 */
@Injectable()
export class MediaProbeService {
  async probe(input: string): Promise<ProbeResult> {
    const { stdout } = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      ...INPUT_GUARDS,
      input,
    ]);
    const data = JSON.parse(stdout.toString()) as FfprobeOutput;
    const streams = data.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    if (!video) {
      throw new NonRetryableProcessingError('Input has no video stream');
    }
    // Some containers (e.g. browser-recorded WebM) carry no duration; fall
    // back to the stream, and store null when it is unknown.
    const duration =
      toNumber(data.format?.duration) ?? toNumber(video.duration) ?? null;
    const metadata: VideoMetadata = {
      format_name: data.format?.format_name ?? null,
      bit_rate: toNumber(data.format?.bit_rate),
      width: video.width ?? null,
      height: video.height ?? null,
      video_codec: video.codec_name ?? null,
      audio_codec: audio?.codec_name ?? null,
      frame_rate: parseFrameRate(video.avg_frame_rate),
    };
    return {
      duration_seconds: duration !== null && duration > 0 ? duration : null,
      metadata,
    };
  }

  /** Renders one JPEG frame at `atSeconds`, 1280 px wide. */
  async extractFrame(input: string, atSeconds: number): Promise<Buffer> {
    const { stdout } = await this.run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      atSeconds.toFixed(3),
      ...INPUT_GUARDS,
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      `scale=${THUMBNAIL_WIDTH}:-2`,
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    if (stdout.length === 0) {
      throw new NonRetryableProcessingError('No frame could be extracted');
    }
    return stdout;
  }

  private run(command: string, args: string[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), PROCESS_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout: Buffer.concat(out), stderr });
          return;
        }
        const reason = `${command} failed (${signal ?? `exit ${code}`}): ${stderr.trim().slice(0, 500)}`;
        reject(
          NON_RETRYABLE_STDERR.some((s) => stderr.includes(s))
            ? new NonRetryableProcessingError(reason)
            : new Error(reason),
        );
      });
    });
  }
}
