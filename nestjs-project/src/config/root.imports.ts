import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import mailConfig from './mail.config';
import messagingConfig from './messaging.config';
import storageConfig from './storage.config';
import swaggerConfig from './swagger.config';
import { envValidationSchema } from './env.validation';

/**
 * Root config + database imports shared by the HTTP app (AppModule) and the
 * video worker (WorkerModule), so both validate the same env and connect the
 * same way (phase-03-videos/TD-05).
 */
export const rootImports = [
  ConfigModule.forRoot({
    isGlobal: true,
    load: [
      appConfig,
      authConfig,
      databaseConfig,
      mailConfig,
      swaggerConfig,
      storageConfig,
      messagingConfig,
    ],
    validationSchema: envValidationSchema,
    validationOptions: { allowUnknown: true, abortEarly: false },
  }),
  TypeOrmModule.forRootAsync({
    imports: [ConfigModule],
    inject: [databaseConfig.KEY],
    useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
      type: 'postgres',
      host: dbConfig.host,
      port: dbConfig.port,
      username: dbConfig.username,
      password: dbConfig.password,
      database: dbConfig.name,
      autoLoadEntities: true,
      synchronize: false,
    }),
  }),
];
