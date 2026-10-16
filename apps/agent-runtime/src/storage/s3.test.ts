import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { PutObjectCommand, HeadBucketCommand, CreateBucketCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createStorage, createS3Client, DEFAULT_BUCKET, type S3Sender } from './s3';

function fakeSender(opts: { headError?: unknown; createError?: unknown } = {}) {
  const sent: unknown[] = [];
  const sender: S3Sender = {
    async send(command: unknown) {
      sent.push(command);
      if (command instanceof HeadBucketCommand) {
        if (opts.headError) throw opts.headError;
        return {};
      }
      if (command instanceof CreateBucketCommand) {
        if (opts.createError) throw opts.createError;
        return {};
      }
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from([Buffer.from('hello')]) };
      }
      return {};
    },
  };
  return { sender, sent };
}

describe('createS3Client', () => {
  it('强制 path-style 且使用传入端点', () => {
    const client = createS3Client({
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_ACCESS_KEY: 'k',
      S3_SECRET_KEY: 's',
    });
    expect(client.config.forcePathStyle).toBe(true);
    expect(client.config.endpoint).toBeTruthy();
  });
});

describe('createStorage', () => {
  it('putObject 传对 Bucket/Key/ContentType/Body', async () => {
    const { sender, sent } = fakeSender();
    const storage = createStorage({ S3_BUCKET: 'mybucket' }, sender);
    await storage.putObject('artifacts/t1/r1/x.pptx', Buffer.from('bytes'), 'application/x-pptx');
    const cmd = sent.find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    expect(cmd.input).toMatchObject({
      Bucket: 'mybucket',
      Key: 'artifacts/t1/r1/x.pptx',
      ContentType: 'application/x-pptx',
    });
  });

  it('bucket 默认取 artifacts', async () => {
    const { sender, sent } = fakeSender();
    const storage = createStorage({}, sender);
    await storage.putObject('k', Buffer.from('b'), 'text/plain');
    const cmd = sent.find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    expect(cmd.input.Bucket).toBe(DEFAULT_BUCKET);
  });

  it('ensureBucket 在 HeadBucket 成功时不建桶', async () => {
    const { sender, sent } = fakeSender();
    await createStorage({}, sender).ensureBucket();
    expect(sent.some((c) => c instanceof CreateBucketCommand)).toBe(false);
  });

  it('ensureBucket 在 HeadBucket 失败时补建桶', async () => {
    const notFound = Object.assign(new Error('NotFound'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const { sender, sent } = fakeSender({ headError: notFound });
    await createStorage({}, sender).ensureBucket();
    expect(sent.some((c) => c instanceof CreateBucketCommand)).toBe(true);
  });

  it('ensureBucket 遇到非 404 错误直接冒泡且不建桶', async () => {
    const forbidden = Object.assign(new Error('Forbidden'), {
      name: 'Forbidden',
      $metadata: { httpStatusCode: 403 },
    });
    const { sender, sent } = fakeSender({ headError: forbidden });
    await expect(createStorage({}, sender).ensureBucket()).rejects.toThrow('Forbidden');
    expect(sent.some((c) => c instanceof CreateBucketCommand)).toBe(false);
  });

  it('ensureBucket 容忍并发创建（BucketAlreadyOwnedByYou）', async () => {
    const notFound = Object.assign(new Error('NotFound'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const alreadyOwned = Object.assign(new Error('BucketAlreadyOwnedByYou'), {
      name: 'BucketAlreadyOwnedByYou',
    });
    const { sender, sent } = fakeSender({ headError: notFound, createError: alreadyOwned });
    await expect(createStorage({}, sender).ensureBucket()).resolves.toBeUndefined();
    expect(sent.some((c) => c instanceof CreateBucketCommand)).toBe(true);
  });

  it('getObjectStream 返回可读流', async () => {
    const { sender } = fakeSender();
    const stream = await createStorage({}, sender).getObjectStream('k');
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });
});
