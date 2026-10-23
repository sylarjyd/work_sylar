import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { ATTACHMENT_STORAGE } from './attachments.storage';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';

type Row = Record<string, any>;

let app: NestFastifyApplication;
const attachments: Row[] = [];
const objects = new Map<string, Buffer>();
const deleted: string[] = [];

const fakePrisma = {
  user: {
    // JwtGuard 按 sub 查库校验状态；u2 属于另一个租户，用于验证隔离。
    findUnique: async ({ where }: { where: { id: string } }) => ({
      status: 'active',
      role: 'member',
      tenantId: where.id === 'u2' ? 't2' : 't1',
      email: `${where.id}@test.local`,
    }),
  },
  attachment: {
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: `a${attachments.length + 1}`,
        sessionId: null,
        messageId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        ...data,
      };
      attachments.push(row);
      return row;
    },
    findFirst: async ({ where }: { where: Row }) =>
      attachments.find(
        (a) =>
          a.id === where.id &&
          (where.tenantId === undefined || a.tenantId === where.tenantId) &&
          (where.userId === undefined || a.userId === where.userId),
      ) ?? null,
    delete: async ({ where }: { where: { id: string } }) => {
      const i = attachments.findIndex((a) => a.id === where.id);
      if (i >= 0) attachments.splice(i, 1);
      return {};
    },
  },
} as unknown as PrismaService;

const fakeStorage = {
  putObject: async (key: string, body: Buffer) => {
    objects.set(key, Buffer.from(body));
  },
  getObjectBuffer: async (key: string) => {
    const buf = objects.get(key);
    if (!buf) throw new Error('NoSuchKey');
    return buf;
  },
  deleteObject: async (key: string) => {
    deleted.push(key);
    objects.delete(key);
  },
};

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  const moduleRef = await Test.createTestingModule({
    controllers: [AttachmentsController],
    providers: [
      AttachmentsService,
      { provide: PrismaService, useValue: fakePrisma },
      { provide: ATTACHMENT_STORAGE, useValue: fakeStorage },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  attachments.length = 0;
  objects.clear();
  deleted.length = 0;
});

const auth = (sub = 'u1') => ({ authorization: `Bearer ${signToken({ sub, tenantId: sub === 'u2' ? 't2' : 't1' })}` });

function multipartForm(filename: string, content: string | Buffer, type = 'text/plain') {
  const boundary = '----attachmentboundary';
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${type}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    body: Buffer.concat([Buffer.from(head), Buffer.from(content), Buffer.from(tail)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('AttachmentsController', () => {
  it('未鉴权返回 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/attachments' });
    expect(res.statusCode).toBe(401);
  });

  it('上传文本附件返回 201 与 DTO（不含 storageKey）', async () => {
    const form = multipartForm('note.txt', 'hello');
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...auth(), ...form.headers },
      payload: form.body,
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload)).toMatchObject({
      id: 'a1',
      kind: 'text',
      filename: 'note.txt',
      mime: 'text/plain',
      size: 5,
    });
    expect(JSON.parse(res.payload)).not.toHaveProperty('storageKey');
    expect(attachments[0]).toMatchObject({ tenantId: 't1', userId: 'u1' });
  });

  it('不支持的文件类型返回 400 且不落库', async () => {
    const form = multipartForm('evil.html', '<script>alert(1)</script>', 'text/html');
    const res = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...auth(), ...form.headers },
      payload: form.body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ error: 'unsupported_type' });
    expect(attachments).toHaveLength(0);
  });

  it('缺少文件返回 400；非 multipart 请求同样按 400 处理', async () => {
    const boundary = '----nofile';
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="other"\r\n\r\n` +
      `hello\r\n--${boundary}--\r\n`;
    const multipartRes = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(multipartRes.statusCode).toBe(400);
    expect(JSON.parse(multipartRes.payload)).toEqual({ error: 'missing_file' });

    const jsonRes = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...auth(), 'content-type': 'application/json' },
      payload: {},
    });
    expect(jsonRes.statusCode).toBe(400);
    expect(JSON.parse(jsonRes.payload)).toEqual({ error: 'invalid_upload' });
  });

  it('内容按租户隔离，命中时返回内联头与原始字节', async () => {
    const form = multipartForm('pic.png', Buffer.from([1, 2, 3]), 'image/png');
    const created = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...auth(), ...form.headers },
      payload: form.body,
    });
    const id = JSON.parse(created.payload).id;

    const other = await app.inject({ method: 'GET', url: `/api/attachments/${id}/content`, headers: auth('u2') });
    expect(other.statusCode).toBe(404);

    const res = await app.inject({ method: 'GET', url: `/api/attachments/${id}/content`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toContain("inline; filename=\"pic.png\"");
    expect(res.rawPayload).toEqual(Buffer.from([1, 2, 3]));
  });

  it('删除未发送附件返回 204；已绑定返回 409；不存在返回 404', async () => {
    const form = multipartForm('note.txt', 'hello');
    const created = await app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...auth(), ...form.headers },
      payload: form.body,
    });
    const id = JSON.parse(created.payload).id;

    attachments[0].messageId = 'm1';
    const conflict = await app.inject({ method: 'DELETE', url: `/api/attachments/${id}`, headers: auth() });
    expect(conflict.statusCode).toBe(409);

    attachments[0].messageId = null;
    const ok = await app.inject({ method: 'DELETE', url: `/api/attachments/${id}`, headers: auth() });
    expect(ok.statusCode).toBe(204);
    expect(deleted).toHaveLength(1);

    const missing = await app.inject({ method: 'DELETE', url: `/api/attachments/${id}`, headers: auth() });
    expect(missing.statusCode).toBe(404);
  });
});
