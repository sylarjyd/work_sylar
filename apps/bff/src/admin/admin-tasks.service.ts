import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AdminRunDetailDto,
  AdminTaskDetailDto,
  AdminTaskItemDto,
  PageDto,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { optionalString, parsePage } from './admin.util';

/** 列表/详情中的目标只做预览，避免管理端一次拉回超长 prompt。 */
const GOAL_PREVIEW_LIMIT = 200;

// 最近一次运行用于列表/详情的状态摘要，只取状态字段。
const LATEST_RUN_INCLUDE = {
  runs: {
    orderBy: { startedAt: 'desc' },
    take: 1,
    select: { status: true },
  },
} as const;

type TaskWithLatestRun = Prisma.TaskGetPayload<{ include: typeof LATEST_RUN_INCLUDE }>;

/** TasksService 写 running/done/failed；queued 是 schema 默认值，留给队列期。 */
function isTaskStatus(v: unknown): v is 'queued' | 'running' | 'done' | 'failed' {
  return v === 'queued' || v === 'running' || v === 'done' || v === 'failed';
}

function toItem(row: TaskWithLatestRun): AdminTaskItemDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    // 按码点截断，避免切裂 emoji 等代理对。
    goal: Array.from(row.goal).slice(0, GOAL_PREVIEW_LIMIT).join(''),
    status: row.status,
    latestRunStatus: row.runs[0]?.status ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 管理端任务与运行：跨租户只读检索，详情与运行查看均留审计。 */
@Injectable()
export class AdminTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, unknown>): Promise<PageDto<AdminTaskItemDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const tenantId = optionalString(query.tenantId);
    const userId = optionalString(query.userId);
    const sessionId = optionalString(query.sessionId);
    const status = optionalString(query.status);
    if (status !== undefined && !isTaskStatus(status)) throw new BadRequestException('invalid_status');

    // 任务表不冗余租户/用户，过滤落在会话维度。
    const sessionFilter: Prisma.SessionWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(userId ? { userId } : {}),
    };
    const where: Prisma.TaskWhereInput = {
      ...(Object.keys(sessionFilter).length > 0 ? { session: { is: sessionFilter } } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(status ? { status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include: LATEST_RUN_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.task.count({ where }),
    ]);

    return { items: rows.map(toItem), total, page, pageSize };
  }

  async detail(id: string, actor: AdminActor): Promise<AdminTaskDetailDto> {
    const row = await this.prisma.task.findUnique({
      where: { id },
      include: LATEST_RUN_INCLUDE,
    });
    if (!row) throw new NotFoundException('task_not_found');

    const runs = await this.prisma.run.findMany({
      where: { taskId: id },
      orderBy: { startedAt: 'desc' },
    });
    // 积分按运行回填；未结算的记录 credits 为空。
    const usage = await this.prisma.usageRecord.findMany({
      where: { runId: { in: runs.map((r) => r.id) } },
      select: { runId: true, credits: true },
    });
    const creditsByRun = new Map(usage.map((u) => [u.runId, u.credits]));

    // 敏感查看审计：失败只记日志，不影响详情返回。
    await this.audit.bestEffort(actor, {
      action: 'task.view',
      targetType: 'task',
      targetId: id,
    });

    return {
      ...toItem(row),
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        endedAt: r.endedAt?.toISOString() ?? null,
        credits: creditsByRun.get(r.id) ?? null,
      })),
    };
  }

  async runDetail(
    id: string,
    query: Record<string, unknown>,
    actor: AdminActor,
  ): Promise<AdminRunDetailDto> {
    const { page, pageSize, skip, take } = parsePage(query.stepPage, query.stepPageSize);
    const row = await this.prisma.run.findUnique({
      where: { id },
      include: {
        steps: { orderBy: { seq: 'asc' }, skip, take },
        _count: { select: { steps: true } },
      },
    });
    if (!row) throw new NotFoundException('run_not_found');

    const usage = await this.prisma.usageRecord.findUnique({ where: { runId: id } });

    // 不记录 step 正文：只记运行与分页范围。
    await this.audit.bestEffort(actor, {
      action: 'run.view',
      targetType: 'run',
      targetId: id,
      summary: { page, pageSize },
    });

    return {
      id: row.id,
      taskId: row.taskId,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      steps: {
        items: row.steps.map((s) => ({
          id: s.id,
          seq: s.seq,
          type: s.type,
          payload: s.payload as Record<string, unknown>,
          ts: s.ts.toISOString(),
        })),
        total: row._count.steps,
        page,
        pageSize,
      },
      usage: usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            credits: usage.credits,
            status: usage.status,
            models: usage.models,
          }
        : null,
    };
  }
}
