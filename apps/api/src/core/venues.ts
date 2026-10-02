import type { ShiftDef } from '@nexora/shared';
import { queryOne, query, type Queryable, getPool } from '../db/pool';
import { notFound } from '../lib/errors';

export interface VenueRow {
  id: string;
  slug: string;
  name: string;
  locality_id: string;
  address: string;
  description: string;
  cuisines: string[];
  rating: number;
  rating_count: number;
  image_url: string;
  cost_for_one_paise: number;
  cost_for_two_paise: number;
  currency: 'USD' | 'INR';
  locale: string;
  reset_buffer_mins: number;
  timezone: string;
  turnaround_mins: number;
  grace_period_mins: number;
  triage_timeout_secs: number;
  allow_upsize_fallback: boolean;
  is_active: boolean;
  blackout: boolean;
  blackout_reason: string | null;
  created_at: Date;
}

export async function getVenueById(id: string, db: Queryable = getPool()): Promise<VenueRow> {
  const v = await queryOne<VenueRow>('SELECT * FROM venues WHERE id = $1', [id], db);
  if (!v) throw notFound('Venue');
  return v;
}

export async function getVenueBySlug(slug: string, db: Queryable = getPool()): Promise<VenueRow> {
  const v = await queryOne<VenueRow>('SELECT * FROM venues WHERE slug = $1', [slug], db);
  if (!v) throw notFound('Venue');
  return v;
}

export async function getShifts(venueId: string, db: Queryable = getPool()): Promise<ShiftDef[]> {
  const rows = await query<{ day_of_week: number; open_time: string; close_time: string }>(
    'SELECT day_of_week, open_time, close_time FROM operating_shifts WHERE venue_id = $1 ORDER BY day_of_week, open_time',
    [venueId],
    db,
  );
  return rows.map((r) => ({ dayOfWeek: r.day_of_week, openTime: r.open_time.slice(0, 5), closeTime: r.close_time.slice(0, 5) }));
}
