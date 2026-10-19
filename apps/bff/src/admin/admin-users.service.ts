import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AdminUserDetailDto,
  AdminUserItemDto,
  AdminUserPatch,
  PageDto,
  UserRole,
  UserStatus,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { optionalString, parsePage } from './admin.util';

interface UserRow {
  id: string;
  email: string;
  tenantId: string;
  role: string;
  status: string;
  createdAt: Date;
  tenant: { name: string };
}

function isStatus(v: unknown): v is UserStatus {
  return v === 'active' || v === 'disabled';
}

function isRole(v: unknown): v is UserRole {
  return v === 'member' || v === 'admin';
}

function toItem(row: UserRow): AdminUserItemDto {
  return {
    id: row.id,
    email: row.email,
    tenantId: row.tenantId,
    tenantName: row.tenant.name,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 管理端用户：分页检索、详情（含计费摘要）与状态/角色变更，变更与审计同事务。 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, unknown>): Promise<PageDto<AdminUserItemDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const q = optionalString(query.q);
    const status = optionalString(query.status);
    const role = optionalString(query.role);
    if (status !== undefined && !isStatus(status)) throw new BadRequestException('invalid_status');
    if (role !== undefined && !isRole(role)) throw new BadRequestException('invalid_role');

    const where: Prisma.UserWhereInput = {
      ...(q ? { email: { contains: q, mode: 'insensitive' } } : {}),
      ...(status ? { status } : {}),
      ...(role ? { role } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: { tenant: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items: rows.map(toItem), total, page, pageSize };
  }

  async detail(id: string, actor: AdminActor): Promise<AdminUserDetailDto> {
    const row = await this.prisma.user.findUnique({
      where: { id },
      include: { tenant: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('user_not_found');

    const [sub, credit, sessionCount] = await Promise.all([
      this.prisma.subscription.findUnique({
        where: { tenantId: row.tenantId },
        include: { plan: { select: { id: true, name: true } } },
      }),
      this.prisma.tenantCredit.findUnique({ where: { tenantId: row.tenantId } }),
      this.prisma.session.count({ where: { userId: id } }),
    ]);

    // 敏感查看审计：失败只记日志，不影响详情返回。
    await this.audit.bestEffort(actor, {
      action: 'user.view',
      targetType: 'user',
      targetId: id,
    });

    return {
      ...toItem(row),
      planId: sub?.plan.id ?? null,
      planName: sub?.plan.name ?? null,
      subscriptionStatus: sub?.status ?? null,
      // 可用余额展示为「总余额 - 预留」，避免管理端看到未扣除预留的虚高值。
      balance: Math.max(0, (credit?.balance ?? 0) - (credit?.reserved ?? 0)),
      reserved: credit?.reserved ?? 0,
      sessionCount,
    };
  }

  async update(id: string, patch: AdminUserPatch, actor: AdminActor): Promise<AdminUserItemDto> {
    // 自我保护先于存在性检查：即使是伪造 id 也不能绕过。
    if (id === actor.id) throw new BadRequestException('cannot_modify_self');

    const status = patch?.status;
    const role = patch?.role;
    if (status === undefined && role === undefined) throw new BadRequestException('invalid_patch');
    if (status !== undefined && !isStatus(status)) throw new BadRequestException('invalid_status');
    if (role !== undefined && !isRole(role)) throw new BadRequestException('invalid_role');

    const row = await this.prisma.user.findUnique({
      where: { id },
      include: { tenant: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('user_not_found');

    const next: { status: UserStatus; role: UserRole } = {
      status: status ?? (row.status as UserStatus),
      role: role ?? (row.role as UserRole),
    };

    // 只检查「从 active admin 变为非 active admin」的情况，覆盖禁用与降级。
    if (row.role === 'admin' && (next.status !== 'active' || next.role !== 'admin')) {
      const others = await this.prisma.user.count({
        where: { id: { not: id }, role: 'admin', status: 'active' },
      });
      if (others === 0) throw new BadRequestException('last_admin');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: next });
      await this.audit.write(tx, actor, {
        action: 'user.update',
        targetType: 'user',
        targetId: id,
        summary: {
          before: { status: row.status, role: row.role },
          after: next,
        },
      });
    });

    return { ...toItem(row), status: next.status, role: next.role };
  }
}
