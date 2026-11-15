import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await dataSource
      .getRepository(User)
      .save({ email: `video_owner_${n}@example.com`, password: 'hashed' });
    return dataSource
      .getRepository(Channel)
      .save({ name: `owner${n}`, nickname: `owner${n}`, user_id: user.id });
  }

  function buildVideo(channelId: string, slug: string): Partial<Video> {
    return {
      channel_id: channelId,
      slug,
      title: 'My video',
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 10737418240,
      storage_key: `videos/${slug}/original`,
    };
  }

  it('defaults status to draft and round-trips bigint size as a number', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      buildVideo(channel.id, 'AAAAAAAAAAA'),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.size_bytes).toBe(10737418240);
    expect(found.duration_seconds).toBeNull();
  });

  it('enforces a unique slug', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, 'BBBBBBBBBBB'));

    await expect(
      videoRepository.save(buildVideo(channel.id, 'BBBBBBBBBBB')),
    ).rejects.toThrow(/duplicate key/);
  });

  it('rejects a video whose channel does not exist', async () => {
    await expect(
      videoRepository.save(
        buildVideo('00000000-0000-4000-8000-000000000000', 'CCCCCCCCCCC'),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('deletes the videos of a channel when the channel is deleted', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, 'DDDDDDDDDDD'));

    await dataSource.query('DELETE FROM "channels" WHERE id = $1', [
      channel.id,
    ]);

    expect(await videoRepository.count()).toBe(0);
  });

  it('stores numeric duration and jsonb metadata', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save({
      ...buildVideo(channel.id, 'EEEEEEEEEEE'),
      status: VideoStatus.READY,
      duration_seconds: 12.345,
      metadata: {
        format_name: 'mov,mp4',
        bit_rate: 1000,
        width: 1280,
        height: 720,
        video_codec: 'h264',
        audio_codec: null,
        frame_rate: 25,
      },
    });

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.duration_seconds).toBe(12.345);
    expect(found.metadata?.video_codec).toBe('h264');
  });
});
