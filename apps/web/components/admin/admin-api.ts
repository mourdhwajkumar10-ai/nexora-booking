'use client';
/**
 * Client-side API helpers for the console. Wraps `api()` so that any 401 sends the operator back to
 * the login page (session expired / logged out elsewhere).
 */
import { api, ApiRequestError } from '@/lib/api';

let redirecting = false;

export function redirectToLogin() {
  if (typeof window === 'undefined' || redirecting) return;
  redirecting = true;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/admin/login?next=${encodeURIComponent(next)}`);
}

export async function adminApi<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  try {
    return await api<T>(path, init);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 401) redirectToLogin();
    throw e;
  }
}

/** Shorthand for JSON POST/PUT/PATCH/DELETE. */
export function send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, json?: unknown): Promise<T> {
  return adminApi<T>(path, { method, json: json ?? (method === 'DELETE' ? undefined : {}) });
}

export function apiCode(e: unknown): string | null {
  return e instanceof ApiRequestError ? e.code : null;
}

export function apiMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message || `Request failed (${e.status})`;
  if (e instanceof TypeError) return 'Network error: the API is unreachable.';
  return e instanceof Error ? e.message : 'Something went wrong';
}

/** "1,250.50" / "1250" -> paise (integer). NaN for invalid input. */
export function rupeesToPaise(input: string): number {
  const n = Number(input.replace(/[,₹\s]/g, ''));
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.round(n * 100);
}

export function paiseToRupeesInput(paise: number): string {
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
