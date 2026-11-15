import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  S3_BUCKET: 'bucket',
  RABBITMQ_URL: 'amqp://user:pass@rabbitmq:5672',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and messaging (phase 03)', () => {
  it.each(['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT', 'S3_BUCKET', 'RABBITMQ_URL'])(
    'should reject a missing %s',
    (key) => {
      const env: Record<string, string | undefined> = { ...requiredEnv };
      delete env[key];
      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should reject a RABBITMQ_URL that is not amqp(s)', () => {
    const { error } = validate({ RABBITMQ_URL: 'http://rabbitmq:5672' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('RABBITMQ_URL');
  });

  it('should apply the decided defaults (1 h URLs, 5 s retry, 3 attempts)', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_PRESIGN_EXPIRES_SECONDS).toBe(3600);
    expect(value.VIDEO_PROCESSING_RETRY_DELAY_MS).toBe(5000);
    expect(value.VIDEO_PROCESSING_MAX_ATTEMPTS).toBe(3);
    expect(value.RABBITMQ_NAMESPACE).toBe('videos');
  });
});
