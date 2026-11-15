import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import messagingConfig from '../config/messaging.config';
import storageConfig from '../config/storage.config';
import { User } from '../users/entities/user.entity';
import {
  deleteQueueNamespace,
  useIsolatedQueueNamespaceForTests,
} from '../test/messaging';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosModule (integration)', () => {
  it('compiles and provides VideosService', async () => {
    // MessagingModule opens the AMQP connection on compile.
    const namespace = useIsolatedQueueNamespaceForTests('videos-module');
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
    await deleteQueueNamespace(namespace);
  });
});
