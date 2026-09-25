'use server';

import { cookies } from 'next/headers';
import { refresh } from 'next/cache';
import { LOCALITY_COOKIE } from '@/components/consumer/constants';

/** Persist the visitor's locality so server components can read it on first render. */
export async function setLocality(slug: string) {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return;
  const jar = await cookies();
  jar.set(LOCALITY_COOKIE, slug, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
  refresh();
}
