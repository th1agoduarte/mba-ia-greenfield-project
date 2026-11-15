import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NonRetryableProcessingError } from '../media/media.errors';
import { MediaProbeService } from '../media/media-probe.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  const videoRepository = { findOneBy: jest.fn(), update: jest.fn() };
  const storage = {
    presignGetObject: jest.fn().mockResolvedValue('http://minio/signed'),
    putObject: jest.fn(),
  };
  const media = { probe: jest.fn(), extractFrame: jest.fn() };
  const message = { video_id: 'video-1' };
  const firstAttempt = { attempt: 1, isLastAttempt: false };
  const lastAttempt = { attempt: 3, isLastAttempt: true };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storage },
        { provide: MediaProbeService, useValue: media },
      ],
    }).compile();
    service = module.get(VideoProcessingService);
    videoRepository.findOneBy.mockResolvedValue({
      id: 'video-1',
      status: VideoStatus.PROCESSING,
      storage_key: 'videos/video-1/original',
    });
  });

  it.each([null, { id: 'video-1', status: VideoStatus.READY }])(
    'acks without work when the video is missing or not processing (%p)',
    async (video) => {
      videoRepository.findOneBy.mockResolvedValue(video);

      await expect(service.handle(message, firstAttempt)).resolves.toBe('ok');
      expect(media.probe).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    },
  );

  it('saves duration, metadata and thumbnail and marks the video ready', async () => {
    media.probe.mockResolvedValue({
      duration_seconds: 20,
      metadata: { video_codec: 'h264' },
    });
    media.extractFrame.mockResolvedValue(Buffer.from('jpeg'));

    await expect(service.handle(message, firstAttempt)).resolves.toBe('ok');

    expect(media.extractFrame).toHaveBeenCalledWith('http://minio/signed', 2);
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      Buffer.from('jpeg'),
      'image/jpeg',
    );
    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      expect.objectContaining({
        status: VideoStatus.READY,
        duration_seconds: 20,
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
      }),
    );
  });

  it('asks for a retry on a transient error before the last attempt', async () => {
    media.probe.mockRejectedValue(new Error('connection reset'));

    await expect(service.handle(message, firstAttempt)).resolves.toBe('retry');
    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('marks the video failed on a transient error at the last attempt', async () => {
    media.probe.mockRejectedValue(new Error('connection reset'));

    await expect(service.handle(message, lastAttempt)).resolves.toBe('fail');
    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, processing_error: 'connection reset' },
    );
  });

  it('marks the video failed at once on a non-retryable error', async () => {
    media.probe.mockRejectedValue(
      new NonRetryableProcessingError('Input has no video stream'),
    );

    await expect(service.handle(message, firstAttempt)).resolves.toBe('fail');
    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.FAILED,
        processing_error: 'Input has no video stream',
      },
    );
  });
});
