'use client';

import type { ArtifactDto, AuthResponse, SessionSummary } from '@ai-office/shared';

const BFF_URL = process.env.NEXT_PUBLIC_BFF_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'ai_office_token';

export function getToken(): string | null {
  return typeof window === 'undefined' ? null : window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
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
  URL.revokeObjectURL(url);
}
