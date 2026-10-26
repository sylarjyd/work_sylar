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
  KbBaseDto,
  KbBaseInput,
  KbBasePatch,
  KbDeleteResultDto,
  KbDocDto,
  MessageDto,
  PlanDto,
  SessionSummary,
  UsageAggregateDto,
} from '@ai-office/shared';
import {
  BFF_URL,
  authFetch,
  clearToken,
  errorText,
  getToken,
  newRequestId,
  newTraceparent,
} from '@ai-office/web-core';

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

/** 历史消息（user / assistant 两角色），用于回看会话。 */
export async function listSessionMessages(sessionId: string): Promise<MessageDto[]> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
  if (!res.ok) throw new Error(`messages_failed_${res.status}`);
  return (await res.json()) as MessageDto[];
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

/** 取消运行：排队中的直接撤销，执行中的交由控制总线通知；终态 run 幂等返回当前状态。 */
export async function cancelRun(runId: string): Promise<{ status: string }> {
  // authFetch 固定带 JSON content-type，空体 POST 会被 Fastify 以 400 拒绝，必须补空对象。
  const res = await authFetch(`/api/runs/${runId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`cancel_failed_${res.status}`);
  return (await res.json()) as { status: string };
}

/** 断线重连的事件流：回放 afterSeq 之后的落库步骤，再接实时事件。 */
export async function streamRun(runId: string, afterSeq?: number): Promise<Response> {
  const q = afterSeq !== undefined ? `?afterSeq=${afterSeq}` : '';
  return authFetch(`/api/runs/${runId}/stream${q}`);
}

/** 提交确认决策：JWT 走请求头。BFF 经控制总线转交给 runtime，只能确认已受理。 */
export async function confirmRun(
  runId: string,
  confirmId: string,
  approved: boolean,
): Promise<{ ok: boolean }> {
  const res = await authFetch(`/api/runs/${runId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ confirmId, approved }),
  });
  if (!res.ok) throw new Error(`confirm_failed_${res.status}`);
  return (await res.json()) as { ok: boolean };
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

// ------------------------------------------------------------------ 知识库
// 服务端把业务码放在 error 字段（如 kb_base_exists），拼进错误消息供页面映射文案。

async function failureCode(res: Response, prefix: string): Promise<Error> {
  let code = '';
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string') code = body.error;
    else if (typeof body.message === 'string') code = body.message;
  } catch {
    // 错误体不一定是 JSON。
  }
  return new Error(`${prefix}_${res.status}${code ? `_${code}` : ''}`);
}

/** 知识库相关的错误码映射；未知错误交回通用文案。 */
export function kbErrorText(err: unknown, fallback: (e: unknown) => string): string {
  const msg = err instanceof Error ? err.message : String(err);
  const map: Record<string, string> = {
    kb_base_not_found: '知识库不存在或已被删除',
    kb_doc_not_found: '文档不存在或已被删除',
    kb_base_exists: '已存在同名知识库，请换个名称',
    invalid_kb_name: '知识库名称不能为空且不超过 60 字',
    invalid_kb_base_patch: '没有需要保存的修改',
    unsupported_type: '不支持的文件类型',
    file_too_large: '文件过大，请压缩后重试',
    missing_file: '请选择要上传的文件',
  };
  for (const [code, text] of Object.entries(map)) {
    if (msg.endsWith(`_${code}`)) return text;
  }
  // 未知业务码：截掉业务码后缀，交给通用文案按 HTTP 状态归类，避免把内部 code 直接展示给用户。
  const status = msg.match(/_(4\d\d|5\d\d)(?:_|$)/);
  if (status?.index !== undefined) {
    return errorText(new Error(msg.slice(0, status.index + status[1].length + 1)));
  }
  return fallback(err);
}

export async function listKbBases(): Promise<KbBaseDto[]> {
  const res = await authFetch('/api/kb/bases');
  if (!res.ok) throw new Error(`kb_list_failed_${res.status}`);
  return (await res.json()) as KbBaseDto[];
}

export async function createKbBase(input: KbBaseInput): Promise<KbBaseDto> {
  const res = await authFetch('/api/kb/bases', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await failureCode(res, 'kb_create_failed');
  return (await res.json()) as KbBaseDto;
}

export async function updateKbBase(id: string, patch: KbBasePatch): Promise<KbBaseDto> {
  const res = await authFetch(`/api/kb/bases/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await failureCode(res, 'kb_update_failed');
  return (await res.json()) as KbBaseDto;
}

export async function deleteKbBase(id: string): Promise<KbDeleteResultDto> {
  const res = await authFetch(`/api/kb/bases/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw await failureCode(res, 'kb_delete_failed');
  return (await res.json()) as KbDeleteResultDto;
}

export async function listKbBaseDocs(baseId: string): Promise<KbDocDto[]> {
  const res = await authFetch(`/api/kb/bases/${encodeURIComponent(baseId)}/docs`);
  if (!res.ok) throw await failureCode(res, 'kb_list_failed');
  return (await res.json()) as KbDocDto[];
}

/** 上传知识库文档。用 FormData：**不能**设 content-type，否则 boundary 丢失（故不走 authFetch 的默认头）。 */
export async function uploadKbBaseDoc(baseId: string, file: File): Promise<KbDocDto> {
  const token = getToken();
  const form = new FormData();
  form.append('file', file);
  const headers: Record<string, string> = {
    traceparent: newTraceparent(),
    'x-request-id': newRequestId(),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BFF_URL}/api/kb/bases/${encodeURIComponent(baseId)}/docs`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (res.status === 401) {
    clearToken();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw await failureCode(res, 'kb_upload_failed');
  return (await res.json()) as KbDocDto;
}

export async function deleteKbBaseDoc(
  baseId: string,
  docId: string,
): Promise<KbDeleteResultDto> {
  const res = await authFetch(
    `/api/kb/bases/${encodeURIComponent(baseId)}/docs/${encodeURIComponent(docId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw await failureCode(res, 'kb_delete_failed');
  return (await res.json()) as KbDeleteResultDto;
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
