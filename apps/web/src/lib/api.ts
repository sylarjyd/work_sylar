'use client';

import type { AuthResponse, SessionSummary } from '@ai-office/shared';

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
  return fetch(`${BFF_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
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
