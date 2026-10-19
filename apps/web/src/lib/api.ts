'use client';

import type {
  ArtifactDto,
  AuthResponse,
  BillingSummaryDto,
  ConnectorDto,
  CreditLedgerPageDto,
  KbDocDto,
  PlanDto,
  SessionSummary,
  UsageAggregateDto,
} from '@ai-office/shared';

const BFF_URL = process.env.NEXT_PUBLIC_BFF_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'ai_office_token';
const ROLE_KEY = 'ai_office_role';

export function getToken(): string | null {
  return typeof window === 'undefined' ? null : window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function getRole(): string | null {
  return typeof window === 'undefined' ? null : window.localStorage.getItem(ROLE_KEY);
}

function setRole(role: string): void {
  window.localStorage.setItem(ROLE_KEY, role);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(ROLE_KEY);
}

export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const res = await fetch(`${BFF_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  // 401 通常意味着 token 已失效：就地清掉，抛出可识别的错误，交由调用方决定跳转登录页。
  if (res.status === 401) {
    clearToken();
    throw new Error('unauthorized');
  }
  return res;
}

/** authFetch 在 401 时抛出的错误，页面据此统一处理「重新登录」。 */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && err.message === 'unauthorized';
}

/** 把认证接口的错误码映射为对用户友好的文案，避免把内部 code 直接显示出来。 */
export function authErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const map: Record<string, string> = {
    login_failed_400: '请输入邮箱和密码',
    login_failed_401: '邮箱或密码错误',
    register_failed_400: '请输入合法的邮箱和密码',
    register_failed_409: '该邮箱已被注册',
  };
  return map[msg] ?? '操作失败，请稍后重试';
}

export async function register(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${BFF_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`register_failed_${res.status}`);
  const data = (await res.json()) as AuthResponse;
  setToken(data.token);
  setRole(data.user.role);
  return data;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${BFF_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login_failed_${res.status}`);
  const data = (await res.json()) as AuthResponse;
  setToken(data.token);
  setRole(data.user.role);
  return data;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await authFetch('/api/sessions');
  if (!res.ok) throw new Error(`sessions_failed_${res.status}`);
  return (await res.json()) as SessionSummary[];
}

export async function createSession(): Promise<SessionSummary> {
  const res = await authFetch('/api/sessions', { method: 'POST', body: JSON.stringify({}) });
  if (!res.ok) throw new Error(`create_session_failed_${res.status}`);
  return (await res.json()) as SessionSummary;
}

export async function streamTask(sessionId: string, goal: string): Promise<Response> {
  return authFetch(`/api/sessions/${sessionId}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ goal }),
  });
}

export async function listArtifacts(sessionId: string): Promise<ArtifactDto[]> {
  const res = await authFetch(`/api/sessions/${sessionId}/artifacts`);
  if (!res.ok) throw new Error(`artifacts_failed_${res.status}`);
  return (await res.json()) as ArtifactDto[];
}

/** 提交确认决策：JWT 走请求头。返回 runtime 的 { ok, matched }（matched=false 表示重复/过期/未知）。 */
export async function confirmRun(
  runId: string,
  confirmId: string,
  approved: boolean,
): Promise<{ ok: boolean; matched: boolean }> {
  const res = await authFetch(`/api/runs/${runId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ confirmId, approved }),
  });
  if (!res.ok) throw new Error(`confirm_failed_${res.status}`);
  return (await res.json()) as { ok: boolean; matched: boolean };
}

/**
 * 下载产物：JWT 走请求头，故不能用 <a href>，须 fetch 取 blob 再触发保存。
 * 文件名从 DTO 传入——浏览器不会把 content-disposition 应用到程序化下载。
 */
export async function downloadArtifact(id: string, filename: string): Promise<void> {
  const res = await authFetch(`/api/artifacts/${id}/download`);
  if (!res.ok) throw new Error(`download_failed_${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 部分浏览器（Safari/Firefox）在 click 后异步读取 blob，立即 revoke 会导致下载为空；延后一帧再回收。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function listKbDocs(): Promise<KbDocDto[]> {
  const res = await authFetch('/api/kb/docs');
  if (!res.ok) throw new Error(`kb_list_failed_${res.status}`);
  return (await res.json()) as KbDocDto[];
}

/** 上传知识库文档。用 FormData：**不能**设 content-type，否则 boundary 丢失（故不走 authFetch 的默认头）。 */
export async function uploadKbDoc(file: File): Promise<KbDocDto> {
  const token = getToken();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BFF_URL}/api/kb/docs`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (res.status === 401) {
    clearToken();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`kb_upload_failed_${res.status}`);
  return (await res.json()) as KbDocDto;
}

export async function deleteKbDoc(id: string): Promise<void> {
  const res = await authFetch(`/api/kb/docs/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`kb_delete_failed_${res.status}`);
}

export async function listConnectors(): Promise<ConnectorDto[]> {
  const res = await authFetch('/api/connectors');
  if (!res.ok) throw new Error(`connectors_failed_${res.status}`);
  return (await res.json()) as ConnectorDto[];
}

export async function createConnector(input: {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}): Promise<ConnectorDto> {
  const res = await authFetch('/api/connectors', { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`connector_create_failed_${res.status}`);
  return (await res.json()) as ConnectorDto;
}

export async function updateConnector(
  id: string,
  patch: { name?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean },
): Promise<ConnectorDto> {
  const res = await authFetch(`/api/connectors/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(`connector_update_failed_${res.status}`);
  return (await res.json()) as ConnectorDto;
}

export async function deleteConnector(id: string): Promise<void> {
  const res = await authFetch(`/api/connectors/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`connector_delete_failed_${res.status}`);
}

export async function listPlans(): Promise<PlanDto[]> {
  const res = await authFetch('/api/billing/plans');
  if (!res.ok) throw new Error(`plans_failed_${res.status}`);
  return (await res.json()) as PlanDto[];
}

export async function getBillingSummary(): Promise<BillingSummaryDto> {
  const res = await authFetch('/api/billing/summary');
  if (!res.ok) throw new Error(`billing_summary_failed_${res.status}`);
  return (await res.json()) as BillingSummaryDto;
}

export async function listCreditLedger(limit = 20, cursor?: string): Promise<CreditLedgerPageDto> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (cursor) qs.set('cursor', cursor);
  const res = await authFetch(`/api/billing/ledger?${qs.toString()}`);
  if (!res.ok) throw new Error(`billing_ledger_failed_${res.status}`);
  return (await res.json()) as CreditLedgerPageDto;
}

export async function getUsage(
  groupBy: 'day' | 'model',
  from?: string,
  to?: string,
): Promise<UsageAggregateDto[]> {
  const qs = new URLSearchParams({ groupBy });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const res = await authFetch(`/api/billing/usage?${qs.toString()}`);
  if (!res.ok) throw new Error(`billing_usage_failed_${res.status}`);
  return (await res.json()) as UsageAggregateDto[];
}
