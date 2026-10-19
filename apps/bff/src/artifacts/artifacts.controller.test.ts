import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { ArtifactController, contentDisposition } from './artifacts.controller';
import { ArtifactService } from './artifacts.service';
import { ARTIFACT_STORAGE, type ArtifactStorage } from './storage';
import { PrismaService } from '../db/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { signToken } from '../auth/jwt';

let app: NestFastifyApplication;
let baseUrl: string;

const row = {
  id: 'a1',
  tenantId: 't1',
  sessionId: 's1',
  runId: 'r1',
  kind: 'pptx',
  filename: '报告.pptx',
  storageKey: 'k',
  size: 5,
  version: 1,
  createdAt: new Date(),
};

const fakePrisma = {
  user: {
    // JwtGuard 会按 sub 查库校验 status/role；测试里按 token 中的 sub 返回对应租户。
    findUnique: async ({ where }: { where: { id: string } }) => ({
      status: 'active',
      role: where.id === 'u2' ? 'member' : 'admin',
      tenantId: where.id === 'u2' ? 't2' : 't1',
      email: `${where.id}@test.local`,
    }),
  },
  artifact: {
    findMany: async () => [row],
    findFirst: async ({ where }: { where: { id: string; tenantId: string } }) =>
      where.id === row.id && where.tenantId === row.tenantId ? row : null,
  },
} as unknown as PrismaService;

const fakeSessions = {
  assertOwned: async () => {},
} as unknown as SessionsService;

const fakeStorage = {
  getObjectStream: async () => Readable.from([Buffer.from('hello')]),
} as unknown as ArtifactStorage;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  const moduleRef = await Test.createTestingModule({
    controllers: [ArtifactController],
    providers: [
      ArtifactService,
      { provide: PrismaService, useValue: fakePrisma },
      { provide: SessionsService, useValue: fakeSessions },
      { provide: ARTIFACT_STORAGE, useValue: fakeStorage },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

describe('ArtifactController', () => {
  it('未鉴权返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/artifacts/a1/download' });
    expect(res.statusCode).toBe(401);
  });

  it('列表返回会话产物', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/sessions/s1/artifacts`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { filename: string }[];
    expect(body[0].filename).toBe('报告.pptx');
  });

  it('下载设置正确响应头并回传字节', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const res = await fetch(`${baseUrl}/api/artifacts/a1/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('presentationml');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(await res.text()).toBe('hello');
  });

  it('越租户下载返回 404', async () => {
    const token = signToken({ sub: 'u2', tenantId: 't9' });
    const res = await fetch(`${baseUrl}/api/artifacts/a1/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('对象缺失返回 502', async () => {
    const token = signToken({ sub: 'u1', tenantId: 't1' });
    const broken = {
      getObjectStream: async () => {
        throw new Error('NoSuchKey');
      },
    } as unknown as ArtifactStorage;
    // 换一个拿不到对象的 storage：直接构造一个临时应用代价过高，
    // 改为对单例 storage 打桩后恢复，保证用例彼此独立。
    const original = fakeStorage.getObjectStream;
    (fakeStorage as { getObjectStream: ArtifactStorage['getObjectStream'] }).getObjectStream =
      broken.getObjectStream;
    try {
      const res = await fetch(`${baseUrl}/api/artifacts/a1/download`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(502);
    } finally {
      (fakeStorage as { getObjectStream: ArtifactStorage['getObjectStream'] }).getObjectStream =
        original;
    }
  });
});

describe('ArtifactController.download 资源回收', () => {
  it('响应 close 时销毁上游 S3 流，避免连接悬挂', async () => {
    const stream = new Readable({ read() {} }); // 永不结束，模拟长下载
    let destroyed = false;
    stream.on('close', () => {
      destroyed = true;
    });
    const service = {
      getForDownload: async () => ({ filename: 'a.pptx', kind: 'pptx', stream }),
    } as unknown as ArtifactService;
    const controller = new ArtifactController(service);
    const raw = new EventEmitter();
    const reply = {
      header: () => reply,
      status: () => reply,
      send: async () => {},
      raw,
    } as unknown as FastifyReply;

    await controller.download({ sub: 'u1', tenantId: 't1' }, 'a1', reply);
    expect(raw.listenerCount('close')).toBe(1);
    raw.emit('close');
    // destroy() 下一 tick 才发 'close'，等一拍再断言。
    await new Promise((r) => setImmediate(r));
    expect(destroyed).toBe(true);
  });
});

describe('contentDisposition', () => {
  it('清洗 CR/LF/引号/反斜杠，非 ASCII 走 filename*', () => {
    const h = contentDisposition('报告\r\n"x\\.pptx');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).toContain('attachment;');
    expect(h).toContain("filename*=UTF-8''");
    const fallback = h.match(/filename="([^"]*)"/);
    expect(fallback).not.toBeNull();
    expect(fallback![1]).not.toMatch(/[\\"]/);
  });
});
