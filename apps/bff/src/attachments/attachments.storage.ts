import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/** 聊天附件读写：上传需要写侧，运行与预览需要读侧，删除用于撤销未发送附件。 */
export const ATTACHMENT_STORAGE = 'ATTACHMENT_STORAGE';

export interface AttachmentStorage {
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObjectBuffer(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
}

/** MinIO 需 path-style 寻址（bucket 作为路径段），否则会把 bucket 当子域名解析失败。 */
export function createAttachmentStorage(env: NodeJS.ProcessEnv = process.env): AttachmentStorage {
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
    async getObjectBuffer(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!out.Body) throw new Error('empty_body');
      const bytes = await out.Body.transformToByteArray();
      return Buffer.from(bytes);
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
