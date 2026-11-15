import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { InvalidUploadPartsException } from '../common/exceptions/domain.exception';
import {
  S3_INVALID_PARTS_ERRORS,
  S3_NO_SUCH_UPLOAD_ERRORS,
  S3_NOT_FOUND_ERRORS,
} from './storage.constants';
import type {
  CompletedPartInput,
  ObjectHead,
  PresignGetOptions,
  StoredPart,
} from './storage.types';

function hasErrorName(err: unknown, names: readonly string[]): boolean {
  return err instanceof S3ServiceException && names.includes(err.name);
}

/**
 * S3-compatible object storage (MinIO locally, S3 in production).
 * Server-side calls use the internal endpoint; presigned URLs handed to
 * clients are signed for the public endpoint (phase-03-videos/TD-03).
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly publicClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = this.buildClient(config.endpoint);
    this.publicClient = this.buildClient(config.publicEndpoint);
  }

  get bucket(): string {
    return this.config.bucket;
  }

  get presignExpiresSeconds(): number {
    return this.config.presignExpiresSeconds;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(`Storage returned no UploadId for ${key}`);
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.presignExpiresSeconds },
    );
  }

  async listParts(key: string, uploadId: string): Promise<StoredPart[]> {
    const parts: StoredPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          part_number: part.PartNumber ?? 0,
          etag: part.ETag ?? '',
          size: part.Size ?? 0,
        });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPartInput[],
  ): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.part_number - b.part_number);
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sorted.map((p) => ({
              PartNumber: p.part_number,
              ETag: p.etag,
            })),
          },
        }),
      );
    } catch (err) {
      if (hasErrorName(err, S3_INVALID_PARTS_ERRORS)) {
        throw new InvalidUploadPartsException();
      }
      // A concurrent call already completed this upload: the object exists.
      if (
        hasErrorName(err, S3_NO_SUCH_UPLOAD_ERRORS) &&
        (await this.headObject(key))
      ) {
        return;
      }
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** Returns null when the object does not exist. */
  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
      };
    } catch (err) {
      if (hasErrorName(err, S3_NOT_FOUND_ERRORS)) {
        return null;
      }
      throw err;
    }
  }

  async presignGetObject(
    key: string,
    options: PresignGetOptions = {},
  ): Promise<string> {
    const disposition = options.downloadFileName
      ? `attachment; filename="${this.safeFileName(options.downloadFileName)}"`
      : undefined;
    return getSignedUrl(
      options.internal ? this.client : this.publicClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: disposition,
      }),
      { expiresIn: this.presignExpiresSeconds },
    );
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  private buildClient(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: this.config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
      // Default checksums (CRC32) break presigned URLs used by external
      // clients and are not needed for MinIO (library-refs.md).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /** Keeps the header value ASCII and quote-safe. */
  private safeFileName(name: string): string {
    return name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  }
}
