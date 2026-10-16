import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

/** Nest 注入令牌：BFF 侧只读（下载代理），与 runtime 的写侧各自实例化。 */
export const ARTIFACT_STORAGE = 'ARTIFACT_STORAGE';

export interface ArtifactStorage {
  getObjectStream(key: string): Promise<Readable>;
}

export function createArtifactStorage(env: NodeJS.ProcessEnv = process.env): ArtifactStorage {
  const bucket = env.S3_BUCKET ?? 'artifacts';
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    region: env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY ?? '',
      secretAccessKey: env.S3_SECRET_KEY ?? '',
    },
  });
  return {
    async getObjectStream(key) {
      const res = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))) as {
        Body?: unknown;
      };
      if (!res.Body) throw new Error('empty_body');
      return res.Body as Readable;
    },
  };
}
