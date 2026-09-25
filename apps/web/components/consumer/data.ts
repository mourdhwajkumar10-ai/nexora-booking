/**
 * Server-side data access for the consumer portal. Wrapped in React.cache so the layout and
 * page share one request per render (no duplicate /localities calls).
 */
import { cache } from 'react';
import { cookies } from 'next/headers';
import type { Locality, PublicReservation, VenueCard, VenueDetail, AvailabilityResponse } from '@nexora/shared';
import { api, ApiRequestError } from '@/lib/api';
import { LOCALITY_COOKIE } from './constants';

export const getLocalities = cache(() => api<Locality[]>('/localities'));

export const getVenues = cache((locality: string) => api<VenueCard[]>(`/venues?locality=${encodeURIComponent(locality)}`));

/** Returns null on 404 so pages can call notFound(). */
export const getVenue = cache(async (slug: string) => {
  try {
    return await api<VenueDetail>(`/venues/${encodeURIComponent(slug)}`);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 404) return null;
    throw e;
  }
});

export async function getAvailability(slug: string, date: string, partySize: number) {
  return api<AvailabilityResponse>(`/venues/${encodeURIComponent(slug)}/availability?date=${date}&partySize=${partySize}`);
}

export const getReservation = cache(async (token: string) => {
  try {
    return await api<PublicReservation>(`/reservations/${encodeURIComponent(token)}`);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 404) return null;
    throw e;
  }
});

/** The locality the visitor picked (cookie), validated against the list; falls back to the first. */
export async function resolveLocality(localities: Locality[]): Promise<Locality | null> {
  const jar = await cookies();
  const slug = jar.get(LOCALITY_COOKIE)?.value;
  return localities.find((l) => l.slug === slug) ?? localities[0] ?? null;
}
