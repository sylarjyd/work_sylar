import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';

export const DEFAULT_BUCKET = 'artifacts';

/** 最小发送接口：生产为 S3Client，单测注入假实现。 */
export interface S3Sender {
  send(command: unknown): Promise<unknown>;
}

export interface Storage {
  ensureBucket(): Promise<void>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObjectStream(key: string): Promise<Readable>;
}

export function createS3Client(env: NodeJS.ProcessEnv = process.env): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    region: env.S3_REGION ?? 'us-east-1',
    // MinIO 用 path-style（bucket 作路径段而非子域），否则 DNS 解析不到虚拟主机。
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY ?? '',
      secretAccessKey: env.S3_SECRET_KEY ?? '',
    },
  });
}

export function createStorage(
  env: NodeJS.ProcessEnv = process.env,
  client: S3Sender = createS3Client(env),
): Storage {
  const bucket = env.S3_BUCKET ?? DEFAULT_BUCKET;
  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    },
    async putObject(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async getObjectStream(key) {
      const res = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))) as {
        Body?: unknown;
      };
      if (!res.Body) throw new Error('empty_body');
      return res.Body as Readable;
    },
  };
}
