import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { attachContentMd5 } from './storage';

interface CapturedRequest {
  headers: Record<string, string>;
  body: string;
  url: string;
}

/** 捕获 SDK 真正发出的请求，避免单测依赖真实 MinIO。 */
function clientWithCapture(captured: CapturedRequest[]): S3Client {
  return new S3Client({
    endpoint: 'http://127.0.0.1:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    requestHandler: {
      handle: async (request: CapturedRequest) => {
        captured.push({
          headers: request.headers,
          body: String(request.body ?? ''),
          url: String(request.url ?? ''),
        });
        const url = String(request.url ?? '');
        const body = url.includes('list-type=2')
          ? '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>artifacts</Name><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>'
          : '<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>';
        // SDK 的校验中间件会流式收集响应体，因此假响应也必须是可读流。
        return { response: { statusCode: 200, headers: {}, body: Readable.from([body]) } };
      },
      updateHttpClientConfig: () => undefined,
      httpHandlerConfigs: () => ({}),
    } as never,
  });
}

describe('attachContentMd5', () => {
  it('为批量删除请求补上 MinIO 必需的 Content-MD5', async () => {
    const captured: CapturedRequest[] = [];
    const client = clientWithCapture(captured);
    attachContentMd5(client);

    await client.send(
      new DeleteObjectsCommand({
        Bucket: 'artifacts',
        Delete: { Objects: [{ Key: 'kb/t/u/b/1/a.txt' }, { Key: 'kb/t/u/b/2/b.pdf' }], Quiet: true },
      }),
    );

    expect(captured).toHaveLength(1);
    const request = captured[0];
    const expected = createHash('md5').update(Buffer.from(request.body, 'utf8')).digest('base64');
    expect(request.headers['content-md5']).toBe(expected);
    expect(request.body).toContain('kb/t/u/b/1/a.txt');
    expect(request.body).toContain('kb/t/u/b/2/b.pdf');
  });

  it('不影响没有请求体的操作', async () => {
    const captured: CapturedRequest[] = [];
    const client = clientWithCapture(captured);
    attachContentMd5(client);

    await client.send(new ListObjectsV2Command({ Bucket: 'artifacts', Prefix: 'kb/' }));

    expect(captured).toHaveLength(1);
    expect(captured[0].headers['content-md5']).toBeUndefined();
  });
});
