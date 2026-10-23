import { createHash } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

/** Nest 注入令牌：KB 上传需要写侧（ARTIFACT_STORAGE 是只读的下载代理）。 */
export const KB_STORAGE = 'KB_STORAGE';

export interface KbStorage {
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  /** 批量删除，返回删除失败的 key；S3 对不存在的 key 视为删除成功。 */
  deleteObjects(keys: string[]): Promise<string[]>;
}

/**
 * MinIO 的批量删除接口强制要求 Content-MD5；AWS SDK v3 新版默认改发 CRC32 校验头，
 * 会导致删除返回 400「Missing required header for this request: Content-Md5」。
 * 这里在序列化后按请求体补算 MD5，兼容 MinIO 与 AWS S3。
 */
export function attachContentMd5(client: S3Client): void {
  client.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as { headers?: Record<string, string>; body?: unknown };
      const body = request?.body;
      const hasBody = typeof body === 'string' || Buffer.isBuffer(body);
      // 流式上传体无法预读，跳过；仅对已序列化的字符串/Buffer 请求补头。
      if (request && hasBody && !request.headers?.['content-md5']) {
        const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
        request.headers = {
          ...(request.headers ?? {}),
          'content-md5': createHash('md5').update(bytes).digest('base64'),
        };
      }
      return next(args);
    },
    { step: 'build', name: 'addContentMd5' },
  );
}

/** MinIO 需 path-style 寻址（bucket 作为路径段），否则会把 bucket 当子域名解析失败。 */
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
  attachContentMd5(client);
  return {
    async putObject(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async deleteObjects(keys) {
      const unique = [...new Set(keys.filter((k) => k.length > 0))];
      const failed: string[] = [];
      // S3 DeleteObjects 单次最多 1000 个 key。
      for (let i = 0; i < unique.length; i += 1000) {
        const batch = unique.slice(i, i + 1000);
        const res = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        for (const err of res.Errors ?? []) {
          if (err.Key) failed.push(err.Key);
        }
      }
      return failed;
    },
  };
}
