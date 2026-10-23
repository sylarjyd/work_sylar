'use client';

import type {
  ArtifactDto,
  AssistantDto,
  AssistantInput,
  AssistantPatch,
  AttachmentDto,
  BillingSummaryDto,
  ClientModelsDto,
  ConnectorDto,
  CreditLedgerPageDto,
  KbDocDto,
  PlanDto,
  SessionSummary,
  UsageAggregateDto,
} from '@ai-office/shared';
import { BFF_URL, authFetch, clearToken, getToken, newRequestId, newTraceparent } from '@ai-office/web-core';

// 认证与请求基础设施由 @ai-office/web-core 提供，这里 re-export 保持既有页面 import 不变。
export {
  authErrorMessage,
  authFetch,
  clearToken,
  fetchMe,
  getEmail,
  getRole,
  getToken,
  isUnauthorized,
  login,
  register,
  setToken,
} from '@ai-office/web-core';

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await authFetch('/api/sessions');
  if (!res.ok) throw new Error(`sessions_failed_${res.status}`);
  return (await res.json()) as SessionSummary[];
}

export async function createSession(
  model?: string,
  assistantId?: string,
): Promise<SessionSummary> {
  const body: { model?: string; assistantId?: string } = {};
  if (model) body.model = model;
  if (assistantId) body.assistantId = assistantId;
  const res = await authFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create_session_failed_${res.status}`);
  return (await res.json()) as SessionSummary;
}

export async function listAssistants(): Promise<AssistantDto[]> {
  const res = await authFetch('/api/assistants');
  if (!res.ok) throw new Error(`assistants_failed_${res.status}`);
  return (await res.json()) as AssistantDto[];
}

export async function createAssistant(input: AssistantInput): Promise<AssistantDto> {
  const res = await authFetch('/api/assistants', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`assistant_create_failed_${res.status}`);
  return (await res.json()) as AssistantDto;
}

export async function updateAssistant(
  id: string,
  patch: AssistantPatch,
): Promise<AssistantDto> {
  const res = await authFetch(`/api/assistants/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`assistant_update_failed_${res.status}`);
  return (await res.json()) as AssistantDto;
}

export async function deleteAssistant(id: string): Promise<void> {
  const res = await authFetch(`/api/assistants/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`assistant_delete_failed_${res.status}`);
}

export async function listModels(): Promise<ClientModelsDto> {
  const res = await authFetch('/api/models');
  if (!res.ok) throw new Error(`models_failed_${res.status}`);
  return (await res.json()) as ClientModelsDto;
}

export async function streamTask(
  sessionId: string,
  goal: string,
  attachmentIds: string[] = [],
): Promise<Response> {
  return authFetch(`/api/sessions/${sessionId}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ goal, ...(attachmentIds.length > 0 ? { attachmentIds } : {}) }),
  });
}

/** 上传聊天附件。FormData 不能手设 content-type，否则 boundary 丢失。 */
export async function uploadAttachment(file: File): Promise<AttachmentDto> {
  const token = getToken();
  const form = new FormData();
  form.append('file', file);
  const headers: Record<string, string> = {
    traceparent: newTraceparent(),
    'x-request-id': newRequestId(),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BFF_URL}/api/attachments`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (res.status === 401) {
    clearToken();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`attachment_upload_failed_${res.status}`);
  return (await res.json()) as AttachmentDto;
}

/** 撤回尚未发送的附件；已绑定消息的附件服务端会拒绝（409）。 */
export async function deleteAttachment(id: string): Promise<void> {
  const res = await authFetch(`/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`attachment_delete_failed_${res.status}`);
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
  const headers: Record<string, string> = {
    traceparent: newTraceparent(),
    'x-request-id': newRequestId(),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BFF_URL}/api/kb/docs`, {
    method: 'POST',
    headers,
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
