import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunModelRoute } from '@ai-office/shared';
import { cleanTitle, fallbackTitle, SessionTitleService } from './session-title.service';
import type { PrismaService } from '../db/prisma.service';

const route: RunModelRoute = {
  model: 'm1',
  baseUrl: 'http://model.local/v1/',
  apiKey: 'sk-test',
};

function makeService(
  updateMany: (args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => Promise<{ count: number }> = async () => ({ count: 1 }),
) {
  const calls: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const prisma = {
    session: {
      updateMany: (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        calls.push(args);
        return updateMany(args);
      },
    },
  } as unknown as PrismaService;
  return { svc: new SessionTitleService(prisma), calls };
}

function jsonResponse(content: string | null, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cleanTitle', () => {
  it('去掉包裹引号、书名号与句末标点', () => {
    expect(cleanTitle('「季度预算复盘」。')).toBe('季度预算复盘');
    expect(cleanTitle('《合同审阅》')).toBe('合同审阅');
    expect(cleanTitle('"周报草稿"')).toBe('周报草稿');
  });

  it('只取首个非空行，忽略模型的解释', () => {
    expect(cleanTitle('\n\n 竞品调研 \n标题说明：xxxx')).toBe('竞品调研');
  });

  it('超过 30 字时按码点截断', () => {
    expect(Array.from(cleanTitle('字'.repeat(40)))).toHaveLength(30);
  });

  it('清洗后为空返回空串，交给调用方回落', () => {
    expect(cleanTitle('「」')).toBe('');
  });
});

describe('fallbackTitle', () => {
  it('压缩空白后截断到 20 字', () => {
    expect(fallbackTitle('  帮我   写一份季度总结  ')).toBe('帮我 写一份季度总结');
    expect(Array.from(fallbackTitle('字'.repeat(40)))).toHaveLength(20);
  });

  it('纯附件消息使用文件名并去掉扩展名', () => {
    expect(fallbackTitle('', '季度报表.xlsx')).toBe('季度报表');
  });

  it('没有文字与附件时使用默认标题', () => {
    expect(fallbackTitle('   ')).toBe('新会话');
  });
});

describe('SessionTitleService', () => {
  it('用会话模型生成标题，条件更新只覆盖未改名的会话', async () => {
    const { svc, calls } = makeService();
    const fetchMock = vi.fn(async () => jsonResponse('「季度预算复盘」。'));
    vi.stubGlobal('fetch', fetchMock);

    svc.schedule({
      sessionId: 's1',
      tenantId: 't1',
      userId: 'u1',
      goal: '帮我复盘季度预算',
      routes: [route],
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://model.local/v1/chat/completions');
    expect(calls[0].where).toMatchObject({
      id: 's1',
      tenantId: 't1',
      userId: 'u1',
      status: 'active',
      titleSource: 'auto',
    });
    expect(calls[0].data).toEqual({ title: '季度预算复盘', titleSource: 'generated' });
  });

  it('模型调用失败时回落到截断标题，仍写回会话', async () => {
    const { svc, calls } = makeService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(null, 500)),
    );

    svc.schedule({
      sessionId: 's2',
      tenantId: 't1',
      userId: 'u1',
      goal: '帮我整理下周的会议安排',
      routes: [route],
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].data).toEqual({
      title: '帮我整理下周的会议安排',
      titleSource: 'generated',
    });
  });

  it('模型返回空标题时使用兜底标题', async () => {
    const { svc, calls } = makeService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(null)),
    );

    svc.schedule({
      sessionId: 's3',
      tenantId: 't1',
      userId: 'u1',
      goal: '对比两家供应商',
      routes: [route],
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].data.title).toBe('对比两家供应商');
  });

  it('没有可用路由时不调用模型，直接用附件名兜底', async () => {
    const { svc, calls } = makeService();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    svc.schedule({
      sessionId: 's4',
      tenantId: 't1',
      userId: 'u1',
      goal: '',
      attachmentName: '需求说明.docx',
      routes: [],
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls[0].data.title).toBe('需求说明');
  });

  it('用户已改名（条件更新 0 行）时不抛错、不覆盖', async () => {
    const { svc, calls } = makeService(async () => ({ count: 0 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('自动标题')),
    );

    svc.schedule({
      sessionId: 's5',
      tenantId: 't1',
      userId: 'u1',
      goal: '随便聊聊',
      routes: [route],
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].where).toMatchObject({ titleSource: 'auto' });
  });
});
