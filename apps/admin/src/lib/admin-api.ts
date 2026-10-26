import type {
  AdminAlertEventDto,
  AdminAlertRuleDto,
  AdminAlertRulePatch,
  AdminAlertTestResultDto,
  AdminAuditItemDto,
  AdminCreditsRequest,
  AdminKbBaseDetailDto,
  AdminKbBaseItemDto,
  AdminKbDeleteInput,
  AdminKbDocDeleteInput,
  AdminKbStatsDto,
  AdminMessageDto,
  AdminMetricDimensionType,
  AdminMetricGranularity,
  AdminMetricTimeseriesDto,
  AdminModelDto,
  AdminModelProviderDto,
  AdminModelsDto,
  AdminModelTestResultDto,
  AdminOverviewDto,
  AdminOverviewRange,
  AdminPlanDeleteInput,
  AdminPlanDto,
  AdminPlanInput,
  AdminPlanPatch,
  AdminRunDetailDto,
  AdminRunTimelineDto,
  AdminSessionDetailDto,
  AdminSessionItemDto,
  AdminSettingDto,
  AdminSettingValue,
  AdminSubscribeRequest,
  AdminTaskDetailDto,
  AdminTaskItemDto,
  AdminTenantDetailDto,
  AdminTenantItemDto,
  AdminUserDetailDto,
  AdminUserItemDto,
  AdminUserPatch,
  BillingSummaryDto,
  CancelRunResultDto,
  KbDeleteResultDto,
  ModelCapability,
  ModelModality,
  PageDto,
  RetryRunResultDto,
} from '@ai-office/shared';
import { authFetch, errorText } from '@ai-office/web-core';

export function isForbidden(err: unknown): boolean {
  return err instanceof Error && err.message === 'forbidden';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authFetch(path, init);
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) {
    let code = '';
    try {
      const body = (await res.json()) as { message?: unknown };
      // Nest 默认异常体把业务码放在 message；校验错误时 message 是数组，按无业务码处理。
      if (typeof body.message === 'string') code = body.message;
    } catch {
      // 错误体不一定是 JSON。
    }
    throw new Error(`admin_failed_${res.status}${code ? `_${code}` : ''}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export function adminErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const map: Record<string, string> = {
    unauthorized: '登录已失效，请重新登录',
    forbidden: '当前账号没有管理权限',
    'admin_failed_429_queue_full': '排队任务过多，请稍后重试',
    'admin_failed_429_rate_limited': '操作过于频繁，请稍后重试',
    'admin_failed_400_cannot_modify_self': '不能修改自己的角色或状态',
    'admin_failed_400_last_admin': '系统必须保留至少一个启用的管理员',
    'admin_failed_400_free_not_deactivatable': '免费套餐不可停用',
    'admin_failed_400_free_not_deletable': '免费套餐是注册默认套餐，不能删除',
    'admin_failed_400_confirm_mismatch': '确认标识与套餐标识不一致，请重新输入',
    'admin_failed_409_plan_in_use': '该套餐仍有租户订阅，请先迁移订阅再删除',
    'admin_failed_404_plan_not_found': '套餐不存在或已被删除',
    'admin_failed_400_model_price_missing': '套餐中的模型必须先配置价格',
    'admin_failed_400_provider_has_models': '该厂商下仍有模型，请先删除模型',
    'admin_failed_400_default_model_in_use': '当前默认模型不能停用或删除，请先更换默认模型',
    'admin_failed_400_model_in_use': '模型正被启用套餐或有效订阅引用，无法删除',
    'admin_failed_400_provider_required': '必须选择厂商',
    'admin_failed_400_invalid_default_model': '默认模型必须存在且已启用',
    'admin_failed_400_invalid_model': '模型名不能为空',
    'admin_failed_400_invalid_base_url': 'Base URL 必须是合法的 http/https 地址',
    'admin_failed_400_provider_url_blocked':
      '该地址指向本机或内网，当前部署不允许；确需接入内网模型服务请开启 MODEL_ALLOW_PRIVATE_BASE_URL',
    'admin_failed_400_invalid_api_key': 'API Key 不能为空',
    'admin_failed_400_invalid_display_name': '展示名称不合法',
    'admin_failed_400_invalid_sort_order': '排序必须是非负整数',
    'admin_failed_400_invalid_price': '价格必须是非负整数',
    'admin_failed_400_invalid_provider_id': '厂商 ID 不能为空',
    'admin_failed_400_invalid_enabled': '启用状态必须是布尔值',
    'admin_failed_400_invalid_provider_name': '厂商名称不能为空',
    'admin_failed_400_invalid_provider_patch': '没有需要更新的厂商字段',
    'admin_failed_400_invalid_model_patch': '没有需要更新的模型字段',
    'admin_failed_400_no_models_available': '当前没有可用模型',
    'admin_failed_400_invalid_plan_id': '套餐标识不合法（仅支持小写字母、数字与连字符）',
    'admin_failed_400_invalid_name': '套餐名称不能为空',
    'admin_failed_400_invalid_allowedModels': '允许模型不能为空',
    'admin_failed_400_invalid_priceCents': '价格必须是非负整数',
    'admin_failed_409_plan_exists': '套餐标识已存在，请更换标识',
    'admin_failed_409_provider_exists': '该厂商名称已存在',
    'admin_failed_409_model_exists': '该模型已存在',
    'admin_failed_404_provider_not_found': '厂商不存在',
    'admin_failed_404_model_not_found': '模型不存在',
    'admin_failed_503_model_provider_unavailable': '厂商密钥无法解密，请联系运维检查 MODEL_ENC_KEY',
    'admin_failed_404_setting_not_found': '参数不存在',
    'admin_failed_400_invalid_kb_ids': '助手绑定的知识库不合法',
    'admin_failed_400_invalid_kb_name': '知识库名称不能为空且不超过 60 字',
    'admin_failed_404_kb_base_not_found': '知识库不存在或已被删除',
    'admin_failed_404_kb_doc_not_found': '文档不存在或不属于该知识库',
    'admin_failed_409_kb_base_exists': '同一用户下已存在同名知识库',
    'admin_failed_400_invalid_kbChunkOverlap': '分块重叠必须小于分块大小',
    'admin_failed_400_invalid_kbChunkSize': '分块大小必须大于分块重叠',
    'admin_failed_400_invalid_value': '参数值超出允许范围',
    'admin_failed_400_invalid_patch': '告警规则参数不合法',
    'admin_failed_404_alert_rule_not_found': '告警规则不存在',
    'admin_failed_409_run_not_retryable': '该运行当前状态不可重试',
    'admin_failed_409_task_busy': '该任务已有新的运行，请刷新',
    'admin_failed_409_task_snapshot_missing': '任务原始输入缺失，无法重试',
    'admin_failed_409_task_not_retryable': '任务当前状态不可重试',
    'admin_failed_404_run_not_found': '运行不存在或已被清理',
  };
  if (map[msg]) return map[msg];
  const failed = /^admin_failed_(\d{3})(?:_(.*))?$/.exec(msg);
  if (failed) {
    const status = Number(failed[1]);
    // 5xx 是服务端问题，不能引导用户改输入；4xx 才视为输入/状态问题。
    if (status >= 500) return '服务暂时不可用，请稍后重试';
    if (status === 404) return '请求的资源不存在';
    return '操作失败，请检查输入';
  }
  return errorText(err);
}

// ------------------------------------------------------------------ 用户
export function listAdminUsers(
  params: { q?: string; status?: string; role?: string; page?: number; pageSize?: number },
): Promise<PageDto<AdminUserItemDto>> {
  return request(`/api/admin/users${query(params)}`);
}

export function getAdminUser(id: string): Promise<AdminUserDetailDto> {
  return request(`/api/admin/users/${encodeURIComponent(id)}`);
}

export function updateAdminUser(id: string, patch: AdminUserPatch): Promise<AdminUserItemDto> {
  return request(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// ------------------------------------------------------------------ 租户
export function listAdminTenants(
  params: { q?: string; planId?: string; page?: number; pageSize?: number },
): Promise<PageDto<AdminTenantItemDto>> {
  return request(`/api/admin/tenants${query(params)}`);
}

export function getAdminTenant(id: string): Promise<AdminTenantDetailDto> {
  return request(`/api/admin/tenants/${encodeURIComponent(id)}`);
}

export function adminSubscribeTenant(
  id: string,
  body: AdminSubscribeRequest,
): Promise<BillingSummaryDto> {
  return request(`/api/admin/tenants/${encodeURIComponent(id)}/subscribe`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function adminAdjustCredits(
  id: string,
  body: AdminCreditsRequest,
): Promise<BillingSummaryDto> {
  return request(`/api/admin/tenants/${encodeURIComponent(id)}/credits`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ------------------------------------------------------------------ 套餐
export function listAdminPlans(): Promise<AdminPlanDto[]> {
  return request('/api/admin/plans');
}

export function createAdminPlan(body: AdminPlanInput): Promise<AdminPlanDto> {
  return request('/api/admin/plans', { method: 'POST', body: JSON.stringify(body) });
}

export function updateAdminPlan(id: string, patch: AdminPlanPatch): Promise<AdminPlanDto> {
  return request(`/api/admin/plans/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteAdminPlan(id: string, body: AdminPlanDeleteInput): Promise<void> {
  return request(`/api/admin/plans/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify(body),
  });
}

// ------------------------------------------------------------------ 会话
export function listAdminSessions(
  params: { tenantId?: string; userId?: string; q?: string; status?: string; page?: number; pageSize?: number },
): Promise<PageDto<AdminSessionItemDto>> {
  return request(`/api/admin/sessions${query(params)}`);
}

export function getAdminSession(id: string): Promise<AdminSessionDetailDto> {
  return request(`/api/admin/sessions/${encodeURIComponent(id)}`);
}

export function listAdminMessages(
  id: string,
  params: { page?: number; pageSize?: number } = {},
): Promise<PageDto<AdminMessageDto>> {
  return request(`/api/admin/sessions/${encodeURIComponent(id)}/messages${query(params)}`);
}

export function archiveAdminSession(id: string): Promise<AdminSessionItemDto> {
  return request(`/api/admin/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'archived' }),
  });
}

// ------------------------------------------------------------------ 任务 / 运行
export function listAdminTasks(
  params: { tenantId?: string; sessionId?: string; userId?: string; status?: string; page?: number; pageSize?: number },
): Promise<PageDto<AdminTaskItemDto>> {
  return request(`/api/admin/tasks${query(params)}`);
}

export function getAdminTask(id: string): Promise<AdminTaskDetailDto> {
  return request(`/api/admin/tasks/${encodeURIComponent(id)}`);
}

export function getAdminRun(
  id: string,
  params: { stepPage?: number; stepPageSize?: number } = {},
): Promise<AdminRunDetailDto> {
  return request(`/api/admin/runs/${encodeURIComponent(id)}${query(params)}`);
}

export function getAdminRunTimeline(id: string): Promise<AdminRunTimelineDto> {
  return request(`/api/admin/runs/${encodeURIComponent(id)}/timeline`);
}

export function adminCancelRun(runId: string): Promise<CancelRunResultDto> {
  // authFetch 固定带 JSON content-type；Fastify 对空体 POST 直接 400，故发送空对象。
  return request(`/api/admin/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function adminRetryRun(runId: string): Promise<RetryRunResultDto> {
  // authFetch 固定带 JSON content-type；Fastify 对空体 POST 直接 400，故发送空对象。
  return request(`/api/admin/runs/${encodeURIComponent(runId)}/retry`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ------------------------------------------------------------------ 模型
export function getAdminModels(): Promise<AdminModelsDto> {
  return request('/api/admin/models');
}

export function createModelProvider(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
}): Promise<AdminModelProviderDto> {
  return request('/api/admin/model-providers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateModelProvider(
  id: string,
  patch: { name?: string; baseUrl?: string; apiKey?: string },
): Promise<AdminModelProviderDto> {
  return request(`/api/admin/model-providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteModelProvider(id: string): Promise<void> {
  return request(`/api/admin/model-providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function createAdminModel(input: {
  model: string;
  displayName?: string;
  providerId: string;
  enabled?: boolean;
  capabilities?: ModelCapability[];
  modalities?: ModelModality[];
  sortOrder?: number;
  prices: { inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number };
}): Promise<AdminModelDto> {
  return request('/api/admin/models', { method: 'POST', body: JSON.stringify(input) });
}

export function updateAdminModel(input: {
  model: string;
  displayName?: string | null;
  providerId?: string;
  enabled?: boolean;
  capabilities?: ModelCapability[];
  modalities?: ModelModality[];
  sortOrder?: number;
  prices?: { inputMilliCreditsPer1k: number; outputMilliCreditsPer1k: number };
}): Promise<AdminModelDto> {
  return request('/api/admin/models', { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteAdminModel(model: string): Promise<void> {
  return request(`/api/admin/models?model=${encodeURIComponent(model)}`, { method: 'DELETE' });
}

export function testAdminModel(model: string): Promise<AdminModelTestResultDto> {
  return request('/api/admin/models/test', { method: 'POST', body: JSON.stringify({ model }) });
}

export function setDefaultModel(model: string): Promise<AdminModelsDto> {
  return request('/api/admin/default-model', { method: 'PUT', body: JSON.stringify({ model }) });
}

// ------------------------------------------------------------------ 知识库
export function getAdminKbStats(): Promise<AdminKbStatsDto> {
  return request('/api/admin/kb/stats');
}

export function listAdminKbBases(params: {
  q?: string;
  tenantId?: string;
  page?: number;
  pageSize?: number;
}): Promise<PageDto<AdminKbBaseItemDto>> {
  return request(`/api/admin/kb/bases${query(params)}`);
}

export function getAdminKbBase(
  id: string,
  params: { docPage?: number; docPageSize?: number } = {},
): Promise<AdminKbBaseDetailDto> {
  return request(`/api/admin/kb/bases/${encodeURIComponent(id)}${query(params)}`);
}

export function deleteAdminKbBase(
  id: string,
  body: AdminKbDeleteInput,
): Promise<KbDeleteResultDto> {
  return request(`/api/admin/kb/bases/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify(body),
  });
}

export function deleteAdminKbDoc(
  baseId: string,
  docId: string,
  body: AdminKbDocDeleteInput,
): Promise<KbDeleteResultDto> {
  return request(
    `/api/admin/kb/bases/${encodeURIComponent(baseId)}/docs/${encodeURIComponent(docId)}`,
    { method: 'DELETE', body: JSON.stringify(body) },
  );
}

// ------------------------------------------------------------------ 参数 / 审计
export function listAdminSettings(): Promise<AdminSettingDto[]> {
  return request('/api/admin/settings');
}

export function updateAdminSetting(key: string, value: AdminSettingValue): Promise<AdminSettingDto> {
  return request(`/api/admin/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}

export function resetAdminSetting(key: string): Promise<void> {
  return request(`/api/admin/settings/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

export function listAdminAudit(
  params: {
    actorId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  },
): Promise<PageDto<AdminAuditItemDto>> {
  return request(`/api/admin/audit${query(params)}`);
}

// ------------------------------------------------------------------ 可观测性
export function getAdminOverview(range: AdminOverviewRange): Promise<AdminOverviewDto> {
  return request(`/api/admin/overview${query({ range })}`);
}

export interface AdminTimeseriesQuery {
  metrics: string;
  from: string;
  to: string;
  granularity?: AdminMetricGranularity;
  dimensionType?: AdminMetricDimensionType;
  dimensionId?: string;
}

export function getAdminMetricTimeseries(
  params: AdminTimeseriesQuery,
): Promise<AdminMetricTimeseriesDto> {
  // 显式展开字段：query 只接受简单记录，接口类型不能直接当作 Record 传入。
  return request(
    `/api/admin/metrics/timeseries${query({
      metrics: params.metrics,
      from: params.from,
      to: params.to,
      granularity: params.granularity,
      dimensionType: params.dimensionType,
      dimensionId: params.dimensionId,
    })}`,
  );
}

// ------------------------------------------------------------------ 告警
export function listAdminAlertRules(): Promise<AdminAlertRuleDto[]> {
  return request('/api/admin/alert-rules');
}

export function updateAdminAlertRule(
  id: string,
  patch: AdminAlertRulePatch,
): Promise<AdminAlertRuleDto> {
  return request(`/api/admin/alert-rules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function listAdminAlertEvents(params: {
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}): Promise<PageDto<AdminAlertEventDto>> {
  return request(`/api/admin/alert-events${query(params)}`);
}

export function sendAdminAlertTest(id: string): Promise<AdminAlertTestResultDto> {
  // authFetch 固定带 JSON content-type；Fastify 对空体 POST 直接 400，故发送空对象。
  return request(`/api/admin/alert-rules/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
