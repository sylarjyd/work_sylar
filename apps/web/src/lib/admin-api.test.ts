import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  adminErrorText,
  createModelPrice,
  getAdminMetricTimeseries,
  getAdminOverview,
  isForbidden,
  listAdminAlertEvents,
  listAdminAlertRules,
  listAdminUsers,
  resetAdminSetting,
  sendAdminAlertTest,
  updateAdminAlertRule,
  updateModelPrice,
} from './admin-api';

afterEach(() => vi.unstubAllGlobals());

function stubWindow() {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => (k === 'ai_office_token' ? 'tok' : null),
      setItem: () => {},
      removeItem: () => {},
    },
  });
}

describe('admin-api', () => {
  it('分页参数拼进 query，空值忽略', async () => {
    stubWindow();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ items: [], total: 0, page: 2, pageSize: 50 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await listAdminUsers({ page: 2, pageSize: 50, q: '' });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(String(url)).toContain('/api/admin/users?page=2&pageSize=50');
    expect(String(url)).not.toContain('q=');
  });

  it('403 映射为 forbidden', async () => {
    stubWindow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
    const err = await listAdminUsers({ page: 1 }).catch((e) => e);
    expect(isForbidden(err)).toBe(true);
  });

  it('按 Nest 异常体从 message 解析业务码并映射文案', async () => {
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ statusCode: 400, message: 'last_admin', error: 'Bad Request' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const err = await listAdminUsers({ page: 1 }).catch((e) => e);
    expect(err.message).toBe('admin_failed_400_last_admin');
    expect(adminErrorText(err)).toBe('系统必须保留至少一个启用的管理员');
  });

  it('409 冲突业务码从 message 解析并映射文案', async () => {
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ statusCode: 409, message: 'model_exists', error: 'Conflict' }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const err = await createModelPrice({
      model: 'gpt-test',
      inputMilliCreditsPer1k: 1,
      outputMilliCreditsPer1k: 2,
    }).catch((e) => e);
    expect(err.message).toBe('admin_failed_409_model_exists');
    expect(adminErrorText(err)).toBe('该模型价格已存在');
  });

  it('204 无响应体时返回 undefined', async () => {
    stubWindow();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(resetAdminSetting('kbChunkSize')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url).endsWith('/api/admin/settings/kbChunkSize')).toBe(true);
    expect(init.method).toBe('DELETE');
  });

  it('路径参数做 URL 编码', async () => {
    stubWindow();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await updateModelPrice('m/s p', { inputMilliCreditsPer1k: 1 });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(String(url)).toContain('/api/admin/model-prices/m%2Fs%20p');
  });

  it('错误码可读文案', () => {
    expect(adminErrorText(new Error('forbidden'))).toBe('当前账号没有管理权限');
    expect(adminErrorText(new Error('admin_failed_400_last_admin'))).toBe(
      '系统必须保留至少一个启用的管理员',
    );
  });

  it('5xx 不提示检查输入', () => {
    expect(adminErrorText(new Error('admin_failed_500_Internal server error'))).toBe(
      '服务暂时不可用，请稍后重试',
    );
  });

  it('无业务码的 404 提示资源不存在', () => {
    expect(adminErrorText(new Error('admin_failed_404'))).toBe('请求的资源不存在');
  });

  it('数组 message 不拼接 HTTP reason phrase', async () => {
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ statusCode: 400, message: ['x'], error: 'Bad Request' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const err = await listAdminUsers({ page: 1 }).catch((e) => e);
    expect(err.message).toBe('admin_failed_400');
    expect(adminErrorText(err)).toBe('操作失败，请检查输入');
  });

  it('概览与序列请求带上范围、指标与维度参数', async () => {
    stubWindow();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getAdminOverview('7d');
    await getAdminMetricTimeseries({
      metrics: 'credits',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      granularity: 'day',
      dimensionType: 'model',
    });

    const urls = fetchMock.mock.calls.map((call) => String((call as unknown as [string])[0]));
    expect(urls[0]).toContain('/api/admin/overview?range=7d');
    expect(urls[1]).toContain(
      '/api/admin/metrics/timeseries?metrics=credits&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-02T00%3A00%3A00.000Z&granularity=day&dimensionType=model',
    );
    expect(urls[1]).not.toContain('dimensionId=');
  });

  it('告警规则、事件与测试投递使用正确的方法和参数', async () => {
    stubWindow();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await listAdminAlertRules();
    await updateAdminAlertRule('r/1', { threshold: 0.5, enabled: false });
    await listAdminAlertEvents({ status: 'firing', page: 2, pageSize: 20 });
    await sendAdminAlertTest('r/1');

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(String(calls[0][0])).toContain('/api/admin/alert-rules');
    expect(String(calls[1][0])).toContain('/api/admin/alert-rules/r%2F1');
    expect(calls[1][1].method).toBe('PATCH');
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ threshold: 0.5, enabled: false });
    expect(String(calls[2][0])).toContain(
      '/api/admin/alert-events?status=firing&page=2&pageSize=20',
    );
    expect(String(calls[3][0])).toContain('/api/admin/alert-rules/r%2F1/test');
    expect(calls[3][1].method).toBe('POST');
  });

  it('告警规则校验失败有专门文案', () => {
    expect(adminErrorText(new Error('admin_failed_400_invalid_patch'))).toBe(
      '告警规则参数不合法',
    );
    expect(adminErrorText(new Error('admin_failed_404_alert_rule_not_found'))).toBe(
      '告警规则不存在',
    );
  });
});
