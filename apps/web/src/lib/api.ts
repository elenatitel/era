'use client';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function readCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

let csrfPromise: Promise<string> | null = null;
async function csrfToken(): Promise<string> {
  const existing = readCookie('pms_csrf');
  if (existing) return existing;
  csrfPromise ??= fetch('/api/auth/csrf', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((b: { csrfToken: string }) => b.csrfToken)
    .finally(() => (csrfPromise = null));
  return csrfPromise;
}

let refreshing: Promise<boolean> | null = null;
/** Single-flight refresh so parallel 401s trigger only one rotation. */
function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': await csrfToken() },
    });
    return res.ok || res.status === 409;
  })().finally(() => {
    setTimeout(() => (refreshing = null), 0);
  });
  return refreshing;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function qs(params: Query): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['x-csrf-token'] = await csrfToken();
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (res.ok) return data as T;
  const err = data?.error ?? { code: 'HTTP_' + res.status, message: res.statusText };
  if (!retried && res.status === 401 && (err.code === 'TOKEN_EXPIRED' || err.code === 'UNAUTHENTICATED') && !path.startsWith('/auth/login')) {
    if (await refreshSession()) return request<T>(method, path, body, true);
  }
  if (!retried && err.code === 'CSRF') {
    document.cookie = 'pms_csrf=; Max-Age=0; path=/';
    return request<T>(method, path, body, true);
  }
  throw new ApiError(res.status, err.code, err.message, err.details);
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path + (query ? qs(query) : '')),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
