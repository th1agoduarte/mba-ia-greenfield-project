import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import messagingConfig from '../config/messaging.config';
import storageConfig from '../config/storage.config';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  it('compiles and provides VideosService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, messagingConfig],
        }),
        // No connection is opened: the DataSource is only built, not initialized.
        TypeOrmModule.forRoot({
          type: 'postgres',
          entities: [User, Channel, Video],
          manualInitialization: true,
        }),
        VideosModule,
      ],
    }).compile();

    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    await module.close();
  });
});
