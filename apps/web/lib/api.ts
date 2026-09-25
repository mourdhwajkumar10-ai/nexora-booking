/**
 * Fetch wrapper for the Nexora API. In the browser it calls same-origin `/api/v1/*` (proxied by
 * next.config rewrites so the httpOnly session cookie flows). On the server it calls API_URL directly.
 */
import type { ApiError } from '@nexora/shared';

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const serverBase = () => process.env.API_URL ?? 'http://localhost:4000';

export async function api<T>(path: string, init: RequestInit & { json?: unknown; cookie?: string } = {}): Promise<T> {
  const isServer = typeof window === 'undefined';
  const url = `${isServer ? serverBase() : ''}/api/v1${path}`;
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (init.cookie) headers.set('cookie', init.cookie);
  const res = await fetch(url, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    credentials: 'include',
    cache: init.cache ?? 'no-store',
  });
  if (!res.ok) {
    let body: ApiError | null = null;
    try {
      body = await res.json();
    } catch {
      /* non-json */
    }
    throw new ApiRequestError(res.status, body?.error.code ?? 'HTTP_ERROR', body?.error.message ?? res.statusText, body?.error.details);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
