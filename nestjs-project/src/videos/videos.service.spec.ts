import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  UploadTooLargeException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { VideoProcessingPublisher } from '../messaging/video-processing.publisher';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  OVERSIZED_UPLOAD_ERROR,
  partCountFor,
  VideosService,
} from './videos.service';

function slugCollision(): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error()) as any;
  err.code = '23505';
  err.detail = 'Key (slug)=(abc) already exists.';
  return err;
}

function draft(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    slug: 'AAAAAAAAAAA',
    status: VideoStatus.DRAFT,
    size_bytes: 150 * 1024 * 1024,
    storage_key: 'videos/video-id/original',
    upload_id: 'upload-1',
    ...overrides,
  } as Video;
}

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn((v: Partial<Video>) => v),
    save: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    listParts: jest.fn(),
    presignExpiresSeconds: 3600,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: VideoProcessingPublisher, useValue: {} },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('partCountFor', () => {
    it('uses 64 MiB parts: 10 GiB → 160 parts, 1 byte → 1 part', () => {
      expect(partCountFor(10 * 1024 ** 3)).toBe(160);
      expect(partCountFor(64 * 1024 ** 2 + 1)).toBe(2);
      expect(partCountFor(1)).toBe(1);
    });
  });

  describe('initiateUpload', () => {
    const dto = {
      title: 't',
      file_name: 'f.mp4',
      file_size: 100,
      content_type: 'video/mp4',
    };

    beforeEach(() => {
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      storageService.createMultipartUpload.mockResolvedValue('upload-1');
    });

    it('retries with a new slug when the slug collides', async () => {
      videoRepository.save
        .mockRejectedValueOnce(slugCollision())
        .mockImplementationOnce((v: Video) => Promise.resolve(v));

      const result = await service.initiateUpload('user-1', dto);

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const [first, second] = videoRepository.create.mock.calls.map(
        ([v]) => (v as Video).slug,
      );
      expect(first).not.toBe(second);
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.upload.part_count).toBe(1);
    });

    it('aborts the multipart upload when the draft cannot be saved', async () => {
      videoRepository.save.mockRejectedValue(slugCollision());

      await expect(
        service.initiateUpload('user-1', dto),
      ).rejects.toBeInstanceOf(QueryFailedError);
      expect(videoRepository.save).toHaveBeenCalledTimes(5);
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/original$/),
        'upload-1',
      );
    });

    it('keeps the original error when the compensating abort also fails', async () => {
      videoRepository.save.mockRejectedValue(new Error('db down'));
      storageService.abortMultipartUpload.mockRejectedValueOnce(
        new Error('storage down'),
      );

      await expect(service.initiateUpload('user-1', dto)).rejects.toThrow(
        'db down',
      );
      expect(storageService.abortMultipartUpload).toHaveBeenCalled();
    });

    it('throws CHANNEL_NOT_FOUND (404) when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      const err = await service.initiateUpload('user-1', dto).catch((e) => e);

      expect(err).toBeInstanceOf(ChannelNotFoundException);
      expect(err).toMatchObject({
        errorCode: 'CHANNEL_NOT_FOUND',
        httpStatus: 404,
      });
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('presignParts', () => {
    it('throws VIDEO_NOT_FOUND when the video is not owned by the user', async () => {
      videoRepository.findOne.mockResolvedValue(null);
      await expect(
        service.presignParts('user-1', 'slug', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws VIDEO_INVALID_STATE when the video is not a draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        draft({ status: VideoStatus.PROCESSING, upload_id: null }),
      );
      await expect(
        service.presignParts('user-1', 'slug', [1]),
      ).rejects.toBeInstanceOf(VideoInvalidStateException);
    });

    it('throws INVALID_PART_NUMBER beyond the part count', async () => {
      videoRepository.findOne.mockResolvedValue(draft());
      await expect(
        service.presignParts('user-1', 'slug', [3, 4]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('signs one URL per requested part', async () => {
      videoRepository.findOne.mockResolvedValue(draft());
      storageService.presignUploadPart.mockImplementation(
        (_k: string, _u: string, n: number) => Promise.resolve(`url-${n}`),
      );

      const result = await service.presignParts('user-1', 'slug', [1, 3]);

      expect(result).toEqual({
        urls: [
          { part_number: 1, url: 'url-1' },
          { part_number: 3, url: 'url-3' },
        ],
        expires_in: 3600,
      });
    });
  });
});

describe('VideosService.completeUpload', () => {
  let service: VideosService;
  const videoRepository = { findOne: jest.fn(), update: jest.fn() };
  const storageService = {
    headObject: jest.fn(),
    completeMultipartUpload: jest.fn(),
    deleteObject: jest.fn(),
  };
  const publisher = { publishVideoUploaded: jest.fn() };
  const parts = [{ part_number: 1, etag: '"e1"' }];

  beforeEach(async () => {
    jest.clearAllMocks();
    videoRepository.update.mockResolvedValue({ affected: 1 });
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: {} },
        { provide: StorageService, useValue: storageService },
        { provide: VideoProcessingPublisher, useValue: publisher },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  it('completes the multipart upload, sets processing and publishes once', async () => {
    videoRepository.findOne.mockResolvedValue(draft());
    storageService.headObject
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ contentLength: 2048, contentType: 'video/mp4' });

    const result = await service.completeUpload('user-1', 'slug', parts);

    expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
      'videos/video-id/original',
      'upload-1',
      parts,
    );
    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: 'video-id', status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING, upload_id: null, size_bytes: 2048 },
    );
    expect(publisher.publishVideoUploaded).toHaveBeenCalledWith('video-id');
    expect(result.status).toBe(VideoStatus.PROCESSING);
  });

  it('commits processing before publishing and compensates to draft when the publish fails', async () => {
    videoRepository.findOne.mockResolvedValue(draft());
    storageService.headObject.mockResolvedValue({
      contentLength: 2048,
      contentType: 'video/mp4',
    });
    publisher.publishVideoUploaded.mockRejectedValueOnce(new Error('down'));

    await expect(
      service.completeUpload('user-1', 'slug', parts),
    ).rejects.toThrow('down');

    expect(videoRepository.update.mock.calls).toEqual([
      [
        { id: 'video-id', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, upload_id: null, size_bytes: 2048 },
      ],
      [
        { id: 'video-id', status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      ],
    ]);
  });

  it('is repeatable while processing: republishes the job without touching the storage or the status', async () => {
    // e.g. a previous call committed `processing` and died before publishing
    videoRepository.findOne.mockResolvedValue(
      draft({ status: VideoStatus.PROCESSING, upload_id: null }),
    );

    const result = await service.completeUpload('user-1', 'slug', parts);

    expect(result.status).toBe(VideoStatus.PROCESSING);
    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    expect(videoRepository.update).not.toHaveBeenCalled();
    expect(publisher.publishVideoUploaded).toHaveBeenCalledWith('video-id');
  });

  it.each([VideoStatus.READY, VideoStatus.FAILED])(
    'rejects a video in status %s with VIDEO_INVALID_STATE',
    async (status) => {
      videoRepository.findOne.mockResolvedValue(
        draft({ status, upload_id: null }),
      );
      await expect(
        service.completeUpload('user-1', 'slug', parts),
      ).rejects.toBeInstanceOf(VideoInvalidStateException);
    },
  );

  it('skips the storage completion when a previous attempt already assembled the object', async () => {
    videoRepository.findOne.mockResolvedValue(draft());
    storageService.headObject.mockResolvedValue({
      contentLength: 2048,
      contentType: 'video/mp4',
    });

    await service.completeUpload('user-1', 'slug', parts);

    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    expect(publisher.publishVideoUploaded).toHaveBeenCalledTimes(1);
  });

  it('rejects an assembled file above 10 GiB: failed, object deleted, UPLOAD_TOO_LARGE', async () => {
    videoRepository.findOne.mockResolvedValue(draft());
    storageService.headObject.mockResolvedValue({
      contentLength: 10737418241,
      contentType: 'video/mp4',
    });

    await expect(
      service.completeUpload('user-1', 'slug', parts),
    ).rejects.toBeInstanceOf(UploadTooLargeException);

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: 'video-id', status: VideoStatus.DRAFT },
      expect.objectContaining({
        status: VideoStatus.FAILED,
        processing_error: OVERSIZED_UPLOAD_ERROR,
      }),
    );
    expect(storageService.deleteObject).toHaveBeenCalledWith(
      'videos/video-id/original',
    );
    expect(publisher.publishVideoUploaded).not.toHaveBeenCalled();
  });

  it('does not publish when a concurrent call already moved the video to processing', async () => {
    videoRepository.findOne
      .mockResolvedValueOnce(draft())
      .mockResolvedValueOnce(
        draft({ status: VideoStatus.PROCESSING, upload_id: null }),
      );
    storageService.headObject.mockResolvedValue({
      contentLength: 2048,
      contentType: 'video/mp4',
    });
    videoRepository.update.mockResolvedValueOnce({ affected: 0 });

    const result = await service.completeUpload('user-1', 'slug', parts);

    expect(result.status).toBe(VideoStatus.PROCESSING);
    expect(publisher.publishVideoUploaded).not.toHaveBeenCalled();
  });

  it('retries a compensated draft (upload_id cleared) without completing the multipart again', async () => {
    videoRepository.findOne.mockResolvedValue(draft({ upload_id: null }));
    storageService.headObject.mockResolvedValue({
      contentLength: 2048,
      contentType: 'video/mp4',
    });

    const result = await service.completeUpload('user-1', 'slug', parts);

    expect(result.status).toBe(VideoStatus.PROCESSING);
    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    expect(publisher.publishVideoUploaded).toHaveBeenCalledWith('video-id');
  });
});

describe('VideosService stream/download', () => {
  let service: VideosService;
  const videoRepository = { findOne: jest.fn() };
  const storageService = {
    presignGetObject: jest.fn().mockResolvedValue('http://storage/signed'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: {} },
        { provide: StorageService, useValue: storageService },
        { provide: VideoProcessingPublisher, useValue: {} },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  it('signs the original for a ready video', async () => {
    videoRepository.findOne.mockResolvedValue(
      draft({ status: VideoStatus.READY, upload_id: null }),
    );

    await expect(service.getStreamUrl('user-1', 'slug')).resolves.toBe(
      'http://storage/signed',
    );
    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      'videos/video-id/original',
    );
  });

  it('signs the download with the original file name', async () => {
    videoRepository.findOne.mockResolvedValue(
      draft({
        status: VideoStatus.READY,
        upload_id: null,
        original_file_name: 'holiday.mp4',
      }),
    );

    await service.getDownloadUrl('user-1', 'slug');

    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      'videos/video-id/original',
      { downloadFileName: 'holiday.mp4' },
    );
  });

  it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
    'rejects stream and download of a %s video with VIDEO_NOT_READY',
    async (status) => {
      videoRepository.findOne.mockResolvedValue(draft({ status }));

      await expect(
        service.getStreamUrl('user-1', 'slug'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
      await expect(
        service.getDownloadUrl('user-1', 'slug'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
    },
  );

  it('answers VIDEO_NOT_FOUND to a non-owner', async () => {
    videoRepository.findOne.mockResolvedValue(null);
    await expect(service.getVideo('user-2', 'slug')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
  });
});
