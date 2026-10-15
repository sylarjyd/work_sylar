import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import * as argon2 from 'argon2';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PrismaService } from '../db/prisma.service';

// 极简内存假库：只实现 AuthService 用到的两个方法。
const users = new Map<string, { id: string; email: string; passwordHash: string; tenantId: string }>();
const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { email: string } }) => users.get(where.email) ?? null,
    create: async ({ data }: { data: { email: string; passwordHash: string } }) => {
      const row = { id: `u${users.size + 1}`, tenantId: `t${users.size + 1}`, ...data };
      users.set(data.email, row);
      return row;
    },
  },
} as unknown as PrismaService;

let app: NestFastifyApplication;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [AuthService, { provide: PrismaService, useValue: fakePrisma }],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe('AuthController', () => {
  it('注册返回 token，且库里存的是哈希而非明文', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@b.com', password: 'pw123456' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe('a@b.com');
    const stored = users.get('a@b.com')!;
    expect(stored.passwordHash).not.toBe('pw123456');
    expect(await argon2.verify(stored.passwordHash, 'pw123456')).toBe(true);
  });

  it('重复邮箱注册返回 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@b.com', password: 'pw123456' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('密码错误登录返回 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@b.com', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });
});
