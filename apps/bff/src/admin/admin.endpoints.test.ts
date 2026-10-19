import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AdminAuditController } from './admin-audit.controller';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../db/prisma.service';
import { signToken } from '../auth/jwt';

const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => ({
      status: 'active',
      role: where.id === 'admin' ? 'admin' : 'member',
      tenantId: 't1',
      email: `${where.id}@test.local`,
    }),
  },
  adminAuditLog: {
    findMany: async () => [],
    count: async () => 0,
  },
} as unknown as PrismaService;

let app: NestFastifyApplication;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminAuditController],
    providers: [AuditService, { provide: PrismaService, useValue: fakePrisma }],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe('管理端鉴权', () => {
  it('普通成员访问 /api/admin/audit 返回 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { authorization: `Bearer ${signToken({ sub: 'u1', tenantId: 't1' })}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('管理员访问返回分页结构', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { authorization: `Bearer ${signToken({ sub: 'admin', tenantId: 't1' })}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('禁用管理员返回 401', async () => {
    const prisma = fakePrisma as unknown as { user: { findUnique: () => Promise<unknown> } };
    const original = prisma.user.findUnique;
    prisma.user.findUnique = async () => ({
      status: 'disabled',
      role: 'admin',
      tenantId: 't1',
      email: 'admin@test.local',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: { authorization: `Bearer ${signToken({ sub: 'admin', tenantId: 't1' })}` },
    });
    prisma.user.findUnique = original;
    expect(res.statusCode).toBe(401);
  });
});
