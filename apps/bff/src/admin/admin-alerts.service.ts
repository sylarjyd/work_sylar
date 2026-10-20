import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PageDto } from '@ai-office/shared';
import type {
  AdminAlertEventDto,
  AdminAlertRuleDto,
  AdminAlertTestResultDto,
} from '@ai-office/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import type { AdminActor } from '../audit/audit.types';
import {
  ALERT_TEST_PAYLOAD_ID,
  AlertWebhookNotifier,
  alertDashboardUrl,
  alertTarget,
  buildAlertPayload,
} from '../alerts/alert-webhook';
import { optionalDate, optionalString, parsePage } from './admin.util';

interface RulePatchData {
  threshold?: number;
  windowMinutes?: number;
  cooldownMinutes?: number;
  severity?: 'warning' | 'critical';
  enabled?: boolean;
}

interface AlertRuleRow {
  id: string;
  key: string;
  name: string;
  metric: string;
  comparator: string;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  severity: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface AlertEventRow {
  id: string;
  ruleId: string;
  ruleName: string;
  status: string;
  value: number;
  message: string;
  startedAt: Date;
  resolvedAt: Date | null;
  notifiedAt: Date | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
}

const PATCH_KEYS = new Set([
  'threshold',
  'windowMinutes',
  'cooldownMinutes',
  'severity',
  'enabled',
]);

function toRuleDto(row: AlertRuleRow): AdminAlertRuleDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    metric: row.metric,
    comparator: row.comparator === 'lt' ? 'lt' : 'gt',
    threshold: row.threshold,
    windowMinutes: row.windowMinutes,
    cooldownMinutes: row.cooldownMinutes,
    severity: row.severity === 'critical' ? 'critical' : 'warning',
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEventDto(row: AlertEventRow): AdminAlertEventDto {
  const deliveryStatus =
    row.deliveryStatus === 'sent' ||
    row.deliveryStatus === 'failed' ||
    row.deliveryStatus === 'skipped'
      ? row.deliveryStatus
      : null;
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    status: row.status === 'resolved' ? 'resolved' : 'firing',
    value: row.value,
    message: row.message,
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    notifiedAt: row.notifiedAt?.toISOString() ?? null,
    deliveryStatus,
    deliveryError: row.deliveryError,
  };
}

function parseIntField(value: unknown, code: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new BadRequestException(code);
  }
  return value;
}

/** 只接受规格允许的五个可编辑字段，未知键与空 body 一律拒绝。 */
function parsePatch(body: unknown): RulePatchData {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('invalid_patch');
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => !PATCH_KEYS.has(key))) {
    throw new BadRequestException('invalid_patch');
  }

  const data: RulePatchData = {};
  if (input.threshold !== undefined) {
    if (typeof input.threshold !== 'number' || !Number.isFinite(input.threshold)) {
      throw new BadRequestException('invalid_threshold');
    }
    data.threshold = input.threshold;
  }
  if (input.windowMinutes !== undefined) {
    data.windowMinutes = parseIntField(input.windowMinutes, 'invalid_window', 1, 1440);
  }
  if (input.cooldownMinutes !== undefined) {
    data.cooldownMinutes = parseIntField(input.cooldownMinutes, 'invalid_cooldown', 0, 1440);
  }
  if (input.severity !== undefined) {
    if (input.severity !== 'warning' && input.severity !== 'critical') {
      throw new BadRequestException('invalid_severity');
    }
    data.severity = input.severity;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new BadRequestException('invalid_enabled');
    data.enabled = input.enabled;
  }
  return data;
}

/** 管理端告警：规则只允许改阈值/窗口/冷却/级别/启停，事件只读。 */
@Injectable()
export class AdminAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifier: AlertWebhookNotifier,
  ) {}

  async listRules(): Promise<AdminAlertRuleDto[]> {
    const rows = await this.prisma.alertRule.findMany({ orderBy: { key: 'asc' } });
    return rows.map(toRuleDto);
  }

  async updateRule(id: string, body: unknown, actor: AdminActor): Promise<AdminAlertRuleDto> {
    const data = parsePatch(body);

    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.alertRule.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('alert_rule_not_found');

      const rule = await tx.alertRule.update({ where: { id }, data });
      if (data.enabled === false) {
        // 停用即视为恢复：否则未恢复事件会永久占着 firing 计数。
        await tx.alertEvent.updateMany({
          where: { ruleId: id, status: 'firing' },
          data: {
            status: 'resolved',
            resolvedAt: new Date(),
            openKey: null,
            deliveryStatus: 'skipped',
            deliveryError: 'rule_disabled',
            notifiedAt: null,
          },
        });
      }

      await this.audit.write(tx, actor, {
        action: 'alertRule.update',
        targetType: 'alert_rule',
        targetId: id,
        summary: { ...data },
      });
      return rule;
    });

    return toRuleDto(updated);
  }

  async listEvents(query: Record<string, unknown>): Promise<PageDto<AdminAlertEventDto>> {
    const { page, pageSize, skip, take } = parsePage(query.page, query.pageSize);
    const status = optionalString(query.status);
    if (status !== undefined && status !== 'firing' && status !== 'resolved') {
      throw new BadRequestException('invalid_status');
    }
    const from = optionalDate(query.from, 'invalid_from');
    const to = optionalDate(query.to, 'invalid_to');

    const where: Prisma.AlertEventWhereInput = {
      ...(status ? { status } : {}),
      ...(from || to
        ? {
            startedAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.alertEvent.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.alertEvent.count({ where }),
    ]);

    return { items: rows.map(toEventDto), total, page, pageSize };
  }

  async sendTest(id: string, actor: AdminActor): Promise<AdminAlertTestResultDto> {
    const rule = await this.prisma.alertRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('alert_rule_not_found');

    const config = await this.settings.getAlertSettings();
    const now = new Date();
    const payload = buildAlertPayload(
      'alert.test',
      rule,
      {
        id: ALERT_TEST_PAYLOAD_ID,
        value: rule.threshold,
        message: `测试告警：${rule.name}`,
        startedAt: now,
      },
      alertDashboardUrl(),
    );
    // 测试投递与真实告警共用同一个限流器，避免测试绕开每小时配额。
    const delivery = await this.notifier.send(payload, alertTarget(config));

    await this.audit.bestEffort(actor, {
      action: 'alertRule.test',
      targetType: 'alert_rule',
      targetId: id,
      summary: {
        deliveryStatus: delivery.deliveryStatus,
        deliveryError: delivery.deliveryError,
      },
    });

    return {
      deliveryStatus: delivery.deliveryStatus,
      deliveryError: delivery.deliveryError,
      notifiedAt: delivery.notifiedAt?.toISOString() ?? null,
    };
  }
}
