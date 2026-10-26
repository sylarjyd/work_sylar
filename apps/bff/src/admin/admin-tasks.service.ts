import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AdminRunDetailDto,
  AdminRunTimelineDto,
  AdminTaskDetailDto,
  AdminTaskItemDto,
  CancelRunResultDto,
  PageDto,
  RetryRunResultDto,
  RunStatus,
} from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AdminActor } from '../audit/audit.types';
import { RunsService } from '../runs/runs.service';
import { optionalString, parsePage } from './admin.util';
import { buildTimelineNodes, TIMELINE_STEP_LIMIT } from './run-timeline';

/** 列表/详情中的目标只做预览，避免管理端一次拉回超长 prompt。 */
const GOAL_PREVIEW_LIMIT = 200;

const RUN_STATUSES = ['queued', 'running', 'done', 'failed', 'canceled'] as const;

/** 数据库 status 是自由字符串；对外契约已收窄，未知历史值归为 failed 以免管理端崩溃。 */
function asRunStatus(value: string): RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value)
    ? (value as RunStatus)
    : 'failed';
}

// 最近一次运行用于列表/详情的状态摘要，只取状态字段。
const LATEST_RUN_INCLUDE = {
  runs: {
    orderBy: { startedAt: 'desc' },
    take: 1,
    select: { status: true },
  },
} as const;

type TaskWithLatestRun = Prisma.TaskGetPayload<{ include: typeof LATEST_RUN_INCLUDE }>;

/** TasksService 写 running/done/failed/canceled；queued 是 schema 默认值，留给队列期。 */
function isTaskStatus(v: unknown): v is 'queued' | 'running' | 'done' | 'failed' | 'canceled' {
  return (
    v === 'queued' || v === 'running' || v === 'done' || v === 'failed' || v === 'canceled'
  );
}

function toItem(row: TaskWithLatestRun): AdminTaskItemDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    // 按码点截断，避免切裂 emoji 等代理对。
    goal: Array.from(row.goal).slice(0, GOAL_PREVIEW_LIMIT).join(''),
    status: asRunStatus(row.status),
    latestRunStatus: row.runs[0] ? asRunStatus(row.runs[0].status) : null,
    attempts: row.attempts,
    queuedAt: (row.queuedAt ?? row.createdAt).toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 管理端任务与运行：跨租户只读检索，详情与运行查看均留审计。 */
@Injectable()
export class AdminTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly runs: RunsService,
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
        attempt: r.attempt,
        status: asRunStatus(r.status),
        startedAt: r.startedAt?.toISOString() ?? null,
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
        checkpoint: { select: { round: true, seq: true, updatedAt: true } },
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
      attempt: row.attempt,
      traceId: row.traceId,
      status: asRunStatus(row.status),
      startedAt: row.startedAt?.toISOString() ?? null,
      endedAt: row.endedAt?.toISOString() ?? null,
      cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
      checkpoint: row.checkpoint
        ? {
            round: row.checkpoint.round,
            seq: row.checkpoint.seq,
            updatedAt: row.checkpoint.updatedAt.toISOString(),
          }
        : null,
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

  async runTimeline(id: string, actor: AdminActor): Promise<AdminRunTimelineDto> {
    const row = await this.prisma.run.findUnique({
      where: { id },
      include: {
        steps: { orderBy: { seq: 'asc' }, take: TIMELINE_STEP_LIMIT },
        _count: { select: { steps: true } },
        // 队列中尚未开始的运行没有 startedAt，时间线以任务入队时间兜底。
        task: { select: { queuedAt: true } },
      },
    });
    if (!row) throw new NotFoundException('run_not_found');

    const usage = await this.prisma.usageRecord.findUnique({ where: { runId: id } });
    await this.audit.bestEffort(actor, {
      action: 'run.timeline_view',
      targetType: 'run',
      targetId: id,
    });

    const startedAt = row.startedAt ?? row.task.queuedAt;
    const { nodes, truncated } = buildTimelineNodes(
      { id: row.id, status: row.status, startedAt, endedAt: row.endedAt },
      row.steps.map((step) => ({
        id: step.id,
        seq: step.seq,
        type: step.type,
        payload: step.payload as Record<string, unknown>,
        ts: step.ts,
      })),
      row._count.steps,
    );

    return {
      runId: row.id,
      status: row.status,
      traceId: row.traceId,
      startedAt: startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      durationMs: row.endedAt
        ? Math.max(0, row.endedAt.getTime() - startedAt.getTime())
        : null,
      nodes,
      truncated,
      usage: usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            credits: usage.credits,
            models: usage.models,
          }
        : null,
    };
  }

  /** 管理端取消运行：先解析目标归属，再以该租户/用户调用领域服务，避免绕过归属校验。 */
  async cancelRun(runId: string, actor: AdminActor): Promise<CancelRunResultDto> {
    const owner = await this.runOwner(runId);
    const result = await this.runs.cancel(runId, owner.tenantId, owner.userId);
    await this.audit.record(actor, {
      action: 'run.cancel',
      targetType: 'run',
      targetId: runId,
      summary: { status: result.status, attempt: owner.attempt },
    });
    return result;
  }

  /** 管理端手动重试：新 run 已入队，审计记录新 attempt 便于追溯。 */
  async retryRun(runId: string, actor: AdminActor): Promise<RetryRunResultDto> {
    const owner = await this.runOwner(runId);
    const result = await this.runs.retry(runId, owner.tenantId, owner.userId);
    await this.audit.record(actor, {
      action: 'run.retry',
      targetType: 'run',
      targetId: runId,
      // 目标仍是原 run，但新 run 的 id 必须记下：只写 targetId 时无法追溯这次重试生成了哪一行。
      summary: { status: 'queued', attempt: result.attempt, runId: result.runId },
    });
    return result;
  }

  /** run -> task -> session 解析归属租户/用户；run 不存在统一 404 run_not_found。 */
  private async runOwner(
    runId: string,
  ): Promise<{ tenantId: string; userId: string; attempt: number }> {
    const row = await this.prisma.run.findUnique({
      where: { id: runId },
      select: {
        attempt: true,
        task: { select: { session: { select: { tenantId: true, userId: true } } } },
      },
    });
    if (!row) throw new NotFoundException('run_not_found');
    return {
      tenantId: row.task.session.tenantId,
      userId: row.task.session.userId,
      attempt: row.attempt,
    };
  }
}
