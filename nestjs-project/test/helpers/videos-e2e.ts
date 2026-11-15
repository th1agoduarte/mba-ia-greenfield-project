import { randomBytes } from 'crypto';
import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Channel } from '../../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { useIsolatedQueueNamespaceForTests } from '../../src/test/messaging';
import { useInternalStorageEndpointForTests } from '../../src/test/storage';
import { User } from '../../src/users/entities/user.entity';

export interface E2EContext {
  app: INestApplication<App>;
  module: TestingModule;
  dataSource: DataSource;
  namespace: string;
}

/**
 * Boots the API like main.ts does, signing presigned URLs for the internal
 * MinIO endpoint and publishing to a throwaway queue namespace (TD-10).
 */
export async function createVideosE2EApp(
  label: string,
  extraImports: Type[] = [],
): Promise<E2EContext> {
  useInternalStorageEndpointForTests();
  const namespace = useIsolatedQueueNamespaceForTests(label);
  const module = await Test.createTestingModule({
    imports: [AppModule, ...extraImports],
  }).compile();
  const app = module.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return { app, module, dataSource: module.get(DataSource), namespace };
}

/** Creates a confirmed user with its channel and returns a valid JWT. */
export async function createUserWithToken(
  ctx: E2EContext,
): Promise<{ userId: string; token: string }> {
  const tag = randomBytes(4).toString('hex');
  const email = `video_${tag}@example.com`;
  const user = await ctx.dataSource
    .getRepository(User)
    .save({ email, password: 'not-used', is_confirmed: true });
  await ctx.dataSource
    .getRepository(Channel)
    .save({ name: `v_${tag}`, nickname: `v_${tag}`, user_id: user.id });
  const token = ctx.module.get(JwtService).sign({ sub: user.id, email });
  return { userId: user.id, token };
}

/** PUTs a buffer to a presigned part URL and returns the ETag. */
export async function putPart(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  if (res.status !== 200) {
    throw new Error(`PUT part failed with ${res.status}`);
  }
  return res.headers.get('etag') ?? '';
}
