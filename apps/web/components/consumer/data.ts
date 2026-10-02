/**
 * Server-side data access for the consumer portal. Wrapped in React.cache so the layout and
 * page share one request per render (no duplicate /localities calls).
 */
import { cache } from 'react';
import { cookies } from 'next/headers';
import type { Locality, PublicReservation, VenueCard, VenueDetail, AvailabilityResponse } from '@nexora/shared';
import { api, ApiRequestError } from '@/lib/api';
import { LOCALITY_COOKIE } from './constants';

import { DEMO_LOCALITIES, DEMO_VENUES, DEMO_VENUE_DETAILS } from './demo-fallback';

export const getLocalities = cache(async () => {
  try {
    return await api<Locality[]>('/localities');
  } catch {
    return DEMO_LOCALITIES;
  }
});

export const getVenues = cache(async (locality: string) => {
  try {
    return await api<VenueCard[]>(`/venues?locality=${encodeURIComponent(locality)}`);
  } catch {
    return DEMO_VENUES[locality] ?? DEMO_VENUES['cyber-city-gurgaon'] ?? [];
  }
});

/** Returns null on 404 so pages can call notFound(). */
export const getVenue = cache(async (slug: string) => {
  try {
    return await api<VenueDetail>(`/venues/${encodeURIComponent(slug)}`);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 404) return null;
    return DEMO_VENUE_DETAILS[slug] ?? null;
  }
});

export async function getAvailability(slug: string, date: string, partySize: number): Promise<AvailabilityResponse> {
  try {
    return await api<AvailabilityResponse>(`/venues/${encodeURIComponent(slug)}/availability?date=${date}&partySize=${partySize}`);
  } catch {
    const times = ['12:00', '12:30', '13:00', '13:30', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00'];
    return {
      venueId: 'demo-venue',
      date,
      partySize,
      turnaroundMins: 90,
      closed: false,
      blackout: false,
      serverTime: new Date().toISOString(),
      slots: times.map((t, i) => ({
        time: t,
        startAt: `${date}T${t}:00`,
        endAt: `${date}T${t}:00`,
        available: true,
        tablesLeft: (i % 3) + 2,
        past: false,
      })),
    };
  }
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
