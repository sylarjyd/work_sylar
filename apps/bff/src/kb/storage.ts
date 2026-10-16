import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/** Nest 注入令牌：KB 上传需要写侧（ARTIFACT_STORAGE 是只读的下载代理）。 */
export const KB_STORAGE = 'KB_STORAGE';

export interface KbStorage {
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
}

export function createKbStorage(env: NodeJS.ProcessEnv = process.env): KbStorage {
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
    async putObject(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
  };
}
