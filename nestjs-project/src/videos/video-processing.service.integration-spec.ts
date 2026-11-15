import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { MediaModule } from '../media/media.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { readSampleVideo } from '../test/fixtures';
import { useInternalStorageEndpointForTests } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingService (integration — Postgres + MinIO + ffmpeg)', () => {
  let module: TestingModule;
  let service: VideoProcessingService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelId: string;

  beforeAll(async () => {
    useInternalStorageEndpointForTests();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        MediaModule,
      ],
      providers: [VideoProcessingService],
    }).compile();
    service = module.get(VideoProcessingService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'worker@example.com', password: 'x' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'worker', nickname: 'worker', user_id: user.id });
    channelId = channel.id;
  });

  async function processingVideo(body: Buffer): Promise<Video> {
    const video = await videoRepository.save({
      channel_id: channelId,
      slug: Math.random().toString(36).slice(2, 13).padEnd(11, 'x'),
      title: 'Worker video',
      status: VideoStatus.PROCESSING,
      original_file_name: 'sample.mp4',
      content_type: 'video/mp4',
      size_bytes: body.length,
      storage_key: 'pending',
    });
    video.storage_key = `videos/${video.id}/original`;
    await videoRepository.save(video);
    await storage.putObject(video.storage_key, body, 'video/mp4');
    return video;
  }

  it('turns a processing video into ready with duration, metadata and a thumbnail', async () => {
    const video = await processingVideo(readSampleVideo());

    const outcome = await service.handle(
      { video_id: video.id },
      { attempt: 1, isLastAttempt: false },
    );

    expect(outcome).toBe('ok');
    const saved = await videoRepository.findOneByOrFail({ id: video.id });
    expect(saved.status).toBe(VideoStatus.READY);
    expect(saved.duration_seconds).toBeCloseTo(2, 0);
    expect(saved.metadata).toMatchObject({ video_codec: 'h264', width: 640 });
    expect(saved.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    const thumb = await storage.headObject(saved.thumbnail_key!);
    expect(thumb?.contentType).toBe('image/jpeg');
    expect(thumb?.contentLength).toBeGreaterThan(0);
  });

  it('marks a file that is not a video as failed with the reason', async () => {
    const video = await processingVideo(Buffer.from('not a video at all'));

    const outcome = await service.handle(
      { video_id: video.id },
      { attempt: 1, isLastAttempt: false },
    );

    expect(outcome).toBe('fail');
    const saved = await videoRepository.findOneByOrFail({ id: video.id });
    expect(saved.status).toBe(VideoStatus.FAILED);
    expect(saved.processing_error).toMatch(/Invalid data|no video stream/);
  });

  it('ignores a duplicate delivery for a video that is already ready', async () => {
    const video = await processingVideo(readSampleVideo());
    await service.handle(
      { video_id: video.id },
      { attempt: 1, isLastAttempt: false },
    );
    const first = await videoRepository.findOneByOrFail({ id: video.id });

    const outcome = await service.handle(
      { video_id: video.id },
      { attempt: 1, isLastAttempt: false },
    );

    expect(outcome).toBe('ok');
    const second = await videoRepository.findOneByOrFail({ id: video.id });
    expect(second.updated_at).toEqual(first.updated_at);
  });
});
