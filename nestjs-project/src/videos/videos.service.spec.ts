import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidPartNumberException,
  VideoInvalidStateException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { partCountFor, VideosService } from './videos.service';

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
