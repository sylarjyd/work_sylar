import type {
  AdminAuditItemDto,
  AdminCreditsRequest,
  AdminMessageDto,
  AdminModelsDto,
  AdminModelPriceDto,
  AdminPlanDto,
  AdminPlanInput,
  AdminPlanPatch,
  AdminRunDetailDto,
  AdminSessionDetailDto,
  AdminSessionItemDto,
  AdminSettingDto,
  AdminSubscribeRequest,
  AdminTaskDetailDto,
  AdminTaskItemDto,
  AdminTenantDetailDto,
  AdminTenantItemDto,
  AdminUserDetailDto,
  AdminUserItemDto,
  AdminUserPatch,
  BillingSummaryDto,
  PageDto,
} from '@ai-office/shared';
import { authFetch } from './api';
import { errorText } from './errors';

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
    'admin_failed_400_cannot_modify_self': '不能修改自己的角色或状态',
    'admin_failed_400_last_admin': '系统必须保留至少一个启用的管理员',
    'admin_failed_400_free_not_deactivatable': '免费套餐不可停用',
    'admin_failed_400_model_price_missing': '套餐中的模型必须先配置价格',
    'admin_failed_400_model_in_use': '模型正被启用套餐引用，无法删除',
    'admin_failed_400_invalid_plan_id': '套餐标识不合法（仅支持小写字母、数字与连字符）',
    'admin_failed_400_invalid_name': '套餐名称不能为空',
    'admin_failed_400_invalid_allowedModels': '允许模型不能为空',
    'admin_failed_400_invalid_priceCents': '价格必须是非负整数',
    'admin_failed_409_plan_exists': '套餐标识已存在，请更换标识',
    'admin_failed_409_model_exists': '该模型价格已存在',
    'admin_failed_404_setting_not_found': '参数不存在',
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

// ------------------------------------------------------------------ 模型
export function getAdminModels(): Promise<AdminModelsDto> {
  return request('/api/admin/models');
}

export function createModelPrice(body: {
  model: string;
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
}): Promise<AdminModelPriceDto> {
  return request('/api/admin/model-prices', { method: 'POST', body: JSON.stringify(body) });
}

export function updateModelPrice(
  model: string,
  patch: { inputMilliCreditsPer1k?: number; outputMilliCreditsPer1k?: number },
): Promise<AdminModelPriceDto> {
  return request(`/api/admin/model-prices/${encodeURIComponent(model)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteModelPrice(model: string): Promise<void> {
  return request(`/api/admin/model-prices/${encodeURIComponent(model)}`, { method: 'DELETE' });
}

// ------------------------------------------------------------------ 参数 / 审计
export function listAdminSettings(): Promise<AdminSettingDto[]> {
  return request('/api/admin/settings');
}

export function updateAdminSetting(key: string, value: number): Promise<AdminSettingDto> {
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
