import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import * as argon2 from 'argon2';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PrismaService } from '../db/prisma.service';

// 极简内存假库：只实现 AuthService 用到的两个方法（键统一小写，模拟大小写不敏感查询）。
interface FakeUser {
  id: string;
  email: string;
  passwordHash: string;
  tenantId: string;
  role: string;
}
const users = new Map<string, FakeUser>();
const fakePrisma = {
  user: {
    findFirst: async ({ where }: { where: { email: { equals: string } } }) =>
      users.get(where.email.equals.toLowerCase()) ?? null,
    create: async ({ data }: { data: { email: string; passwordHash: string; role: string } }) => {
      const row = { id: `u${users.size + 1}`, tenantId: `t${users.size + 1}`, ...data };
      users.set(data.email, row);
      return row;
    },
  },
} as unknown as PrismaService;

/** 直接往假库塞一个已注册用户，避免用注册接口为其它用例铺状态。 */
async function seedUser(email: string, password: string): Promise<void> {
  const passwordHash = await argon2.hash(password);
  users.set(email.toLowerCase(), {
    id: `u${users.size + 1}`,
    tenantId: `t${users.size + 1}`,
    email: email.toLowerCase(),
    passwordHash,
    role: 'member',
  });
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

  it('注册一律为 member，不再按 ADMIN_EMAILS 自动提权', async () => {
    process.env.ADMIN_EMAILS = 'boss@x.com';
    try {
      const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'boss@x.com', password: 'pw123456' } });
      expect(JSON.parse(res.payload).user.role).toBe('member');
    } finally {
      delete process.env.ADMIN_EMAILS;
    }
  });

  it('注册邮箱统一存小写，大小写不同的重复邮箱返回 409', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'Boss@X.com', password: 'pw123456' },
    });
    expect(first.statusCode).toBe(201);
    expect(JSON.parse(first.payload).user.email).toBe('boss@x.com');
    expect(users.has('boss@x.com')).toBe(true);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'boss@x.COM', password: 'pw123456' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('登录邮箱大小写不敏感', async () => {
    await seedUser('a@b.com', 'pw123456');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'A@B.COM', password: 'pw123456' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('非法邮箱类型返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 42, password: 'pw123456' },
    });
    expect(res.statusCode).toBe(400);
  });
});
