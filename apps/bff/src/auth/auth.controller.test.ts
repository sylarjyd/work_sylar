import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

/** 直接往假库塞一个已注册用户，避免用注册接口为其它用例铺状态。 */
async function seedUser(email: string, password: string): Promise<void> {
  const passwordHash = await argon2.hash(password);
  users.set(email, { id: `u${users.size + 1}`, tenantId: `t${users.size + 1}`, email, passwordHash });
}

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

// 每个用例都从空库开始，各自显式铺自己需要的状态，用例之间不再互相依赖。
beforeEach(() => {
  users.clear();
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
    await seedUser('a@b.com', 'pw123456');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@b.com', password: 'pw123456' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('密码错误登录返回 401', async () => {
    await seedUser('a@b.com', 'pw123456');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@b.com', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('凭据正确时登录返回 token 与用户信息', async () => {
    await seedUser('a@b.com', 'pw123456');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@b.com', password: 'pw123456' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe('a@b.com');
  });

  it('ADMIN_EMAILS 命中的邮箱注册为 admin，其余为 member', async () => {
    process.env.ADMIN_EMAILS = 'boss@x.com, Chief@X.com';
    try {
      const a = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'boss@x.com', password: 'pw123456' } });
      expect(JSON.parse(a.payload).user.role).toBe('admin');
      const b = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'peon@x.com', password: 'pw123456' } });
      expect(JSON.parse(b.payload).user.role).toBe('member');
      const c = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'chief@x.com', password: 'pw123456' } });
      expect(JSON.parse(c.payload).user.role).toBe('admin');
    } finally {
      delete process.env.ADMIN_EMAILS;
    }
  });

  it('未设置 ADMIN_EMAILS 时注册为 member', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'nobody@x.com', password: 'pw123456' } });
    expect(JSON.parse(res.payload).user.role).toBe('member');
  });
});
