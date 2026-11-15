import { randomBytes } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import messagingConfig from '../config/messaging.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { videoProcessingTopology } from '../messaging/messaging.constants';
import { VideoProcessingPublisher } from '../messaging/video-processing.publisher';
import {
  deleteQueueNamespace,
  drainQueue,
  useIsolatedQueueNamespaceForTests,
} from '../test/messaging';
import { useInternalStorageEndpointForTests } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — Postgres + MinIO)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let namespace: string;
  let userId: string;

  beforeAll(async () => {
    useInternalStorageEndpointForTests();
    namespace = useIsolatedQueueNamespaceForTests('videos-svc');
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, messagingConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    await module.init();
    service = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await module.close();
    await deleteQueueNamespace(namespace);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'svc@example.com', password: 'x' });
    await dataSource
      .getRepository(Channel)
      .save({ name: 'svc', nickname: 'svc', user_id: user.id });
    userId = user.id;
  });

  const dto = {
    title: 'Integration video',
    file_name: 'clip.mp4',
    file_size: 2048,
    content_type: 'video/mp4',
  };

  it('persists a draft with its storage key and an open multipart upload', async () => {
    const result = await service.initiateUpload(userId, dto);

    const video = await videoRepository.findOneByOrFail({ id: result.id });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.storage_key).toBe(`videos/${video.id}/original`);
    expect(video.upload_id).toBeTruthy();
    await expect(
      storage.listParts(video.storage_key, video.upload_id!),
    ).resolves.toEqual([]);
  });

  it('lists the parts stored through the presigned URLs', async () => {
    const { slug } = await service.initiateUpload(userId, dto);
    const { urls } = await service.presignParts(userId, slug, [1]);

    await fetch(urls[0].url, {
      method: 'PUT',
      body: new Uint8Array(randomBytes(2048)),
    });

    const { parts } = await service.listUploadedParts(userId, slug);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ part_number: 1, size: 2048 });
  });

  it('aborts the upload and deletes the draft', async () => {
    const { slug, id } = await service.initiateUpload(userId, dto);
    const { storage_key, upload_id } = await videoRepository.findOneByOrFail({
      id,
    });

    await service.abortUpload(userId, slug);

    expect(await videoRepository.countBy({ id })).toBe(0);
    await expect(storage.listParts(storage_key, upload_id!)).rejects.toThrow();
  });

  async function uploadOnePart(slug: string): Promise<string> {
    const { urls } = await service.presignParts(userId, slug, [1]);
    const res = await fetch(urls[0].url, {
      method: 'PUT',
      body: new Uint8Array(randomBytes(2048)),
    });
    return res.headers.get('etag') ?? '';
  }

  it('completes the upload: object assembled, status processing, one video.uploaded message', async () => {
    const { slug, id } = await service.initiateUpload(userId, dto);
    const etag = await uploadOnePart(slug);

    const result = await service.completeUpload(userId, slug, [
      { part_number: 1, etag },
    ]);

    expect(result.status).toBe(VideoStatus.PROCESSING);
    const video = await videoRepository.findOneByOrFail({ id });
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.upload_id).toBeNull();
    expect((await storage.headObject(video.storage_key))?.contentLength).toBe(
      2048,
    );
    const messages = await drainQueue(videoProcessingTopology(namespace).queue);
    expect(messages).toEqual([
      { body: { video_id: id }, headers: { 'x-attempt': 1 } },
    ]);

    // Repeating the call while processing republishes (recovers a call that
    // died between the status commit and the publish).
    await service.completeUpload(userId, slug, [{ part_number: 1, etag }]);
    expect(await drainQueue(videoProcessingTopology(namespace).queue)).toEqual([
      { body: { video_id: id }, headers: { 'x-attempt': 1 } },
    ]);
    expect((await videoRepository.findOneByOrFail({ id })).status).toBe(
      VideoStatus.PROCESSING,
    );
  });

  it('keeps the video in draft when publishing fails, and a retry succeeds', async () => {
    const { slug, id } = await service.initiateUpload(userId, dto);
    const etag = await uploadOnePart(slug);
    const publisher = module.get(VideoProcessingPublisher);
    const spy = jest
      .spyOn(publisher, 'publishVideoUploaded')
      .mockRejectedValueOnce(new Error('broker unavailable'));

    await expect(
      service.completeUpload(userId, slug, [{ part_number: 1, etag }]),
    ).rejects.toThrow('broker unavailable');
    expect((await videoRepository.findOneByOrFail({ id })).status).toBe(
      VideoStatus.DRAFT,
    );

    spy.mockRestore();
    await service.completeUpload(userId, slug, [{ part_number: 1, etag }]);
    expect((await videoRepository.findOneByOrFail({ id })).status).toBe(
      VideoStatus.PROCESSING,
    );
    expect(
      await drainQueue(videoProcessingTopology(namespace).queue),
    ).toHaveLength(1);
  });
});
