import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminAlertsService } from './admin-alerts.service';
import type { PrismaService } from '../db/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { SettingsService } from '../settings/settings.service';
import type { AlertWebhookNotifier, AlertDelivery } from '../alerts/alert-webhook';
import type { AdminActor } from '../audit/audit.types';

const actor: AdminActor = { id: 'a1', email: 'admin@test.local' };

const ruleRow = {
  id: 'rule1',
  key: 'run_failure_rate',
  name: '运行失败率',
  metric: 'run_failure_rate',
  comparator: 'gt',
  threshold: 0.5,
  windowMinutes: 15,
  cooldownMinutes: 30,
  severity: 'warning',
  enabled: true,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-02T00:00:00Z'),
};

const events = [
  {
    id: 'e1',
    ruleId: 'rule1',
    ruleName: '运行失败率',
    status: 'firing',
    value: 0.8,
    message: '运行失败率 0.8 超过阈值 0.5',
    startedAt: new Date('2026-10-20T00:00:00Z'),
    resolvedAt: null,
    notifiedAt: new Date('2026-10-20T00:00:05Z'),
    deliveryStatus: 'sent',
    deliveryError: null,
  },
  {
    id: 'e2',
    ruleId: 'rule1',
    ruleName: '运行失败率',
    status: 'resolved',
    value: 0.2,
    message: '运行失败率 0.2 已恢复',
    startedAt: new Date('2026-10-19T00:00:00Z'),
    resolvedAt: new Date('2026-10-19T01:00:00Z'),
    notifiedAt: null,
    deliveryStatus: 'skipped',
    deliveryError: 'rule_disabled',
  },
];

function makeService(options: { sendResult?: AlertDelivery } = {}) {
  const rules = [{ ...ruleRow }];
  const updateManyCalls: any[] = [];
  const auditWrites: unknown[] = [];
  const auditBestEffort: unknown[] = [];
  const sent: Array<{ payload: any; target: any }> = [];

  const matchEvent = (event: (typeof events)[number], where: any) => {
    if (where?.status && event.status !== where.status) return false;
    const range = where?.startedAt;
    if (range?.gte && event.startedAt.getTime() < range.gte.getTime()) return false;
    if (range?.lte && event.startedAt.getTime() > range.lte.getTime()) return false;
    return true;
  };

  const prisma: any = {
    alertRule: {
      findMany: async () => rules,
      findUnique: async ({ where }: any) => rules.find((rule) => rule.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const rule = rules.find((item) => item.id === where.id);
        if (!rule) throw new Error('missing rule');
        Object.assign(rule, data, { updatedAt: new Date('2026-10-20T00:00:00Z') });
        return { ...rule };
      },
    },
    alertEvent: {
      count: async ({ where }: any) => events.filter((event) => matchEvent(event, where)).length,
      findMany: async ({ where, skip = 0, take = events.length }: any) =>
        events
          .filter((event) => matchEvent(event, where))
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
          .slice(skip, skip + take),
      updateMany: async (args: any) => {
        updateManyCalls.push(args);
        return { count: 1 };
      },
    },
  };
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);

  const audit = {
    write: async (_tx: unknown, _actor: AdminActor, entry: unknown) => {
      auditWrites.push(entry);
    },
    bestEffort: async (_actor: AdminActor, entry: unknown) => {
      auditBestEffort.push(entry);
    },
  } as unknown as AuditService;

  const settings = {
    getAlertSettings: async () => ({
      enabled: true,
      webhookUrl: 'https://hooks.example/a',
      webhookSecret: 'topsecret',
    }),
  } as unknown as SettingsService;

  const notifier = {
    send: async (payload: unknown, target: unknown) => {
      sent.push({ payload, target });
      return (
        options.sendResult ?? {
          deliveryStatus: 'sent',
          deliveryError: null,
          notifiedAt: new Date('2026-10-20T00:00:05Z'),
        }
      );
    },
  } as unknown as AlertWebhookNotifier;

  return {
    svc: new AdminAlertsService(
      prisma as unknown as PrismaService,
      audit,
      settings,
      notifier,
    ),
    updateManyCalls,
    auditWrites,
    auditBestEffort,
    sent,
  };
}

describe('AdminAlertsService', () => {
  it('listRules 映射 DTO', async () => {
    const { svc } = makeService();
    const rules = await svc.listRules();
    expect(rules[0]).toEqual({
      id: 'rule1',
      key: 'run_failure_rate',
      name: '运行失败率',
      metric: 'run_failure_rate',
      comparator: 'gt',
      threshold: 0.5,
      windowMinutes: 15,
      cooldownMinutes: 30,
      severity: 'warning',
      enabled: true,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    });
  });

  it('updateRule 在事务内更新规则并审计', async () => {
    const { svc, auditWrites } = makeService();
    const rule = await svc.updateRule(
      'rule1',
      { threshold: 0.9, windowMinutes: 30, cooldownMinutes: 0, severity: 'critical' },
      actor,
    );
    expect(rule).toMatchObject({
      threshold: 0.9,
      windowMinutes: 30,
      cooldownMinutes: 0,
      severity: 'critical',
    });
    expect(auditWrites[0]).toMatchObject({
      action: 'alertRule.update',
      targetType: 'alert_rule',
      targetId: 'rule1',
    });
  });

  it('停用规则时同事务关闭未恢复事件', async () => {
    const { svc, updateManyCalls } = makeService();
    await svc.updateRule('rule1', { enabled: false }, actor);
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0].where).toEqual({ ruleId: 'rule1', status: 'firing' });
    expect(updateManyCalls[0].data).toMatchObject({
      status: 'resolved',
      openKey: null,
      deliveryStatus: 'skipped',
      deliveryError: 'rule_disabled',
      notifiedAt: null,
      resolvedAt: expect.any(Date),
    });
  });

  it('updateRule 校验字段范围与未知键', async () => {
    const { svc } = makeService();
    for (const patch of [
      {},
      { foo: 1 },
      { threshold: 'x' },
      { windowMinutes: 0 },
      { windowMinutes: 1441 },
      { cooldownMinutes: -1 },
      { severity: 'info' },
      { enabled: 'yes' },
    ]) {
      await expect(svc.updateRule('rule1', patch, actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    await expect(
      svc.updateRule('missing', { threshold: 1 }, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listEvents 按状态与开始时间分页', async () => {
    const { svc } = makeService();
    const page = await svc.listEvents({
      status: 'firing',
      from: '2026-10-19T12:00:00Z',
      to: '2026-10-21T00:00:00Z',
      page: '1',
      pageSize: '10',
    });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: 'e1',
      status: 'firing',
      deliveryStatus: 'sent',
      startedAt: '2026-10-20T00:00:00.000Z',
      notifiedAt: '2026-10-20T00:00:05.000Z',
    });
    await expect(svc.listEvents({ status: 'open' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.listEvents({ from: 'not-a-date' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('sendTest 构造 alert.test 载荷、投递并审计', async () => {
    const previous = process.env.ADMIN_WEB_URL;
    process.env.ADMIN_WEB_URL = 'https://ops.example/';
    try {
      const { svc, sent, auditBestEffort } = makeService();
      const result = await svc.sendTest('rule1', actor);
      expect(result).toEqual({
        deliveryStatus: 'sent',
        deliveryError: null,
        notifiedAt: '2026-10-20T00:00:05.000Z',
      });
      expect(sent[0].payload).toMatchObject({
        version: 1,
        type: 'alert.test',
        alert: {
          id: 'test',
          ruleKey: 'run_failure_rate',
          value: 0.5,
          message: '测试告警：运行失败率',
        },
        dashboardUrl: 'https://ops.example/admin/alerts',
      });
      expect(sent[0].target).toMatchObject({
        url: 'https://hooks.example/a',
        secret: 'topsecret',
      });
      expect(auditBestEffort[0]).toMatchObject({
        action: 'alertRule.test',
        targetType: 'alert_rule',
        targetId: 'rule1',
      });
    } finally {
      if (previous === undefined) delete process.env.ADMIN_WEB_URL;
      else process.env.ADMIN_WEB_URL = previous;
    }
  });

  it('sendTest 返回跳过结果且不吞掉错误摘要', async () => {
    const { svc } = makeService({
      sendResult: {
        deliveryStatus: 'skipped',
        deliveryError: 'webhook_not_configured',
        notifiedAt: null,
      },
    });
    await expect(svc.sendTest('rule1', actor)).resolves.toEqual({
      deliveryStatus: 'skipped',
      deliveryError: 'webhook_not_configured',
      notifiedAt: null,
    });
    await expect(svc.sendTest('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
