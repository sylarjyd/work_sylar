import type { AuthResponse, AuthUser } from '@ai-office/shared';
import { newRequestId, newTraceparent } from './trace';

/**
 * 客户端与运营端共用的认证/请求层。
 * 两端是不同的 origin，localStorage 天然隔离，各自身份互不影响。
 */
/** BFF 地址是构建期变量（NEXT_PUBLIC_* 会被 Next 内联）。 */
export const BFF_URL = process.env.NEXT_PUBLIC_BFF_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'ai_office_token';
const ROLE_KEY = 'ai_office_role';
const EMAIL_KEY = 'ai_office_email';

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

export function getEmail(): string | null {
  return typeof window === 'undefined' ? null : window.localStorage.getItem(EMAIL_KEY);
}

function setEmail(email: string): void {
  window.localStorage.setItem(EMAIL_KEY, email);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(ROLE_KEY);
  window.localStorage.removeItem(EMAIL_KEY);
}

export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const res = await fetch(`${BFF_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // 每次调用新建 trace：BFF 会把它作为父上下文继续派生。
      traceparent: newTraceparent(),
      'x-request-id': newRequestId(),
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
    headers: {
      'content-type': 'application/json',
      traceparent: newTraceparent(),
      'x-request-id': newRequestId(),
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`register_failed_${res.status}`);
  const data = (await res.json()) as AuthResponse;
  setToken(data.token);
  setRole(data.user.role);
  setEmail(data.user.email);
  return data;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${BFF_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      traceparent: newTraceparent(),
      'x-request-id': newRequestId(),
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login_failed_${res.status}`);
  const data = (await res.json()) as AuthResponse;
  setToken(data.token);
  setRole(data.user.role);
  setEmail(data.user.email);
  return data;
}

/**
 * 用当前 token 拉取并回填身份信息。
 * 每次打开页面调用，既补齐早先 token 缺失的邮箱，也让角色变更及时反映。
 * 401 由 authFetch 统一清除登录态并抛出 unauthorized。
 */
export async function fetchMe(): Promise<AuthUser> {
  const token = getToken();
  const res = await authFetch('/api/auth/me');
  if (!res.ok) throw new Error(`me_failed_${res.status}`);
  const user = (await res.json()) as AuthUser;
  // 请求期间可能已退出或切换账号：仅当 token 未变时才写回，避免迟到响应污染新登录态。
  if (token && getToken() === token) {
    setRole(user.role);
    setEmail(user.email);
  }
  return user;
}
