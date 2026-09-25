import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE = 'nexora_session';

/**
 * Optimistic gate for the admin console: visitors without a session cookie are sent to the login
 * page. The authoritative check happens server-side via `/auth/me` in the console layout.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname === '/admin/login' || pathname.startsWith('/admin/login/')) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/admin/login';
  url.search = '';
  if (pathname !== '/admin') url.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/admin/:path*'],
};
