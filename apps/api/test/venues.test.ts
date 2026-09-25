import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DiningTableDto, VenueCard, VenueDetail, VenueSettings } from '@nexora/shared';
import { getPool } from '../src/db/pool';
import { hashPassword } from '../src/lib/auth';
import { clock } from '../src/lib/clock';
import { on } from '../src/lib/bus';
import { createTestContext, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
beforeEach(async () => {
  await ctx.reset();
});
afterAll(async () => {
  await ctx.close();
});

const api = (path: string) => `/api/v1${path}`;

async function req(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, cookie?: string, payload?: unknown) {
  return ctx.app.inject({ method, url: api(path), headers: cookie ? { cookie } : {}, payload: payload as any });
}

let phoneSeq = 0;
/** Insert a reservation directly (bypasses the booking module, which is owned by another team). */
async function insertReservation(o: { tableId: string; partySize: number; start: string; end: string; status?: string; venueId?: string }) {
  const pool = getPool();
  const g = (await pool.query(`INSERT INTO guests (first_name, phone_number) VALUES ('Res', $1) RETURNING id`, [`+9199000${String(++phoneSeq).padStart(5, '0')}`])).rows[0];
  const r = await pool.query(
    `INSERT INTO reservations (venue_id, table_id, guest_id, party_size, booking_date, start_at, end_at, status)
     VALUES ($1,$2,$3,$4,'2026-10-02',$5,$6,$7) RETURNING id, status`,
    [o.venueId ?? ctx.fx.venueId, o.tableId, g.id, o.partySize, o.start, o.end, o.status ?? 'CONFIRMED'],
  );
  return r.rows[0] as { id: string; status: string };
}

/**
 * Session cookie for a fixture user, signed directly: /auth/login is rate-limited (10/min) and is
 * already covered by auth.test.ts.
 */
async function cookieFor(email: string): Promise<string> {
  const u = (await getPool().query('SELECT id, email, name, role, venue_id FROM staff_users WHERE email = $1', [email])).rows[0];
  const token = ctx.app.jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, venueId: u.venue_id }, { expiresIn: '1h' });
  return `nexora_session=${token}`;
}

function login(role: 'manager' | 'host' | 'other' = 'manager'): Promise<string> {
  return cookieFor(role === 'manager' ? ctx.fx.managerEmail : role === 'host' ? ctx.fx.hostEmail : ctx.fx.otherVenueHostEmail);
}

/** Venue-scoped MANAGER of the *other* venue (the fixture only has an org-wide manager). */
async function otherVenueManager(): Promise<string> {
  await getPool().query(`INSERT INTO staff_users (venue_id, email, name, role, password_hash) VALUES ($1,'om@test.dev','Other Mgr','MANAGER',$2)`, [
    ctx.fx.otherVenueId,
    hashPassword(ctx.fx.password),
  ]);
  return cookieFor('om@test.dev');
}

async function auditActions(venueId = ctx.fx.venueId): Promise<string[]> {
  const rows = await getPool().query('SELECT action FROM audit_logs WHERE venue_id = $1', [venueId]);
  return rows.rows.map((r) => r.action);
}

// ---------------------------------------------------------------- E1-S1 / S2
describe('public directory', () => {
  it('lists localities sorted by sort_order with "Name, City" labels', async () => {
    await getPool().query(`INSERT INTO localities (slug, name, city, sort_order) VALUES ('bkc','BKC','Mumbai',-1)`);
    const res = await req('GET', '/localities');
    expect(res.statusCode).toBe(200);
    expect(res.json().map((l: any) => l.slug)).toEqual(['bkc', 'cyber-city']);
    expect(res.json()[1]).toMatchObject({ name: 'Cyber City', city: 'Gurgaon', label: 'Cyber City, Gurgaon' });
  });

  it('filters by locality, sorts by rating, returns [] for unknown locality', async () => {
    const pool = getPool();
    const loc = (await pool.query(`INSERT INTO localities (slug, name, city) VALUES ('bkc','BKC','Mumbai') RETURNING id`)).rows[0];
    await pool.query(`INSERT INTO venues (slug, name, locality_id, rating, cost_for_one_paise, cost_for_two_paise) VALUES ('mumbai-spot','Mumbai Spot',$1,4.9,100,200)`, [loc.id]);

    const cc = (await req('GET', '/venues?locality=cyber-city')).json() as VenueCard[];
    expect(cc.map((v) => v.slug)).toEqual(['test-bistro', 'other-place']); // 4.5 before 4.0
    expect(cc[0]).toMatchObject({ localityLabel: 'Cyber City, Gurgaon', rating: 4.5, costForOnePaise: 80000, cuisines: ['Italian'] });

    const bkc = (await req('GET', '/venues?locality=bkc')).json() as VenueCard[];
    expect(bkc.map((v) => v.slug)).toEqual(['mumbai-spot']);

    const unknown = await req('GET', '/venues?locality=nowhere');
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual([]);
  });

  it('computes isOpenNow and todayHours at the frozen clock (Fri 18:00 IST, open 12–23)', async () => {
    const [card] = ((await req('GET', '/venues?locality=cyber-city')).json() as VenueCard[]).filter((v) => v.slug === 'test-bistro');
    expect(card.isOpenNow).toBe(true);
    expect(card.acceptingBookings).toBe(true);
    expect(card.todayHours).toEqual([{ openTime: '12:00', closeTime: '23:00' }]);

    clock.set('2026-10-02T18:00:00.000Z'); // 23:30 IST
    const late = ((await req('GET', '/venues')).json() as VenueCard[]).find((v) => v.slug === 'test-bistro')!;
    expect(late.isOpenNow).toBe(false);
  });

  it('treats a previous-day shift that closes after midnight as open now', async () => {
    const cookie = await login('manager');
    // Thursday 20:00–02:00 only.
    const put = await req('PUT', `/admin/venues/${ctx.fx.venueId}/shifts`, cookie, { shifts: [{ dayOfWeek: 4, openTime: '20:00', closeTime: '02:00' }] });
    expect(put.statusCode).toBe(200);

    clock.set('2026-10-01T19:30:00.000Z'); // Fri 01:00 IST
    let v = (await req('GET', '/venues/test-bistro')).json() as VenueDetail;
    expect(v.isOpenNow).toBe(true);
    expect(v.todayHours).toEqual([]); // Friday itself has no shifts

    clock.set('2026-10-01T21:30:00.000Z'); // Fri 03:00 IST
    v = (await req('GET', '/venues/test-bistro')).json() as VenueDetail;
    expect(v.isOpenNow).toBe(false);
  });

  it('returns venue detail with shifts, and 404 for unknown/inactive venues', async () => {
    const res = await req('GET', '/venues/test-bistro');
    expect(res.statusCode).toBe(200);
    const v = res.json() as VenueDetail;
    expect(v).toMatchObject({ slug: 'test-bistro', timezone: 'Asia/Kolkata', turnaroundMins: 30, gracePeriodMins: 15 });
    expect(v.shifts).toHaveLength(7);
    expect(v).not.toHaveProperty('blackout');
    expect((await req('GET', '/venues/nope')).statusCode).toBe(404);
  });

  it('hides inactive venues from the directory and detail', async () => {
    const cookie = await login('manager');
    const patch = await req('PATCH', `/admin/venues/${ctx.fx.venueId}`, cookie, { isActive: false });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().isActive).toBe(false);

    const list = (await req('GET', '/venues?locality=cyber-city')).json() as VenueCard[];
    expect(list.map((v) => v.slug)).toEqual(['other-place']);
    expect((await req('GET', '/venues/test-bistro')).statusCode).toBe(404);
    // still manageable from the console
    expect((await req('GET', `/admin/venues/${ctx.fx.venueId}`, cookie)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- E1-S3
describe('venue settings', () => {
  it('returns VenueSettings to any staff of the venue', async () => {
    const res = await req('GET', `/admin/venues/${ctx.fx.venueId}`, await login('host'));
    expect(res.statusCode).toBe(200);
    const s = res.json() as VenueSettings;
    expect(s).toMatchObject({ id: ctx.fx.venueId, isActive: true, blackout: false, blackoutReason: null, allowUpsizeFallback: true, triageTimeoutSecs: 300 });
    expect(s.shifts).toHaveLength(7);
  });

  it('403s staff of another venue, 401s anonymous, 404s unknown ids', async () => {
    expect((await req('GET', `/admin/venues/${ctx.fx.venueId}`, await login('other'))).statusCode).toBe(403);
    expect((await req('GET', `/admin/venues/${ctx.fx.venueId}`)).statusCode).toBe(401);
    const mgr = await login('manager');
    expect((await req('GET', '/admin/venues/not-a-uuid', mgr)).statusCode).toBe(404);
    expect((await req('GET', '/admin/venues/00000000-0000-0000-0000-000000000000', mgr)).statusCode).toBe(404);
  });

  it('PATCH updates fields and writes an audit row', async () => {
    const res = await req('PATCH', `/admin/venues/${ctx.fx.venueId}`, await login('manager'), {
      name: 'Test Bistro II',
      turnaroundMins: 45,
      gracePeriodMins: 10,
      allowUpsizeFallback: false,
      costForTwoPaise: 160000,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Test Bistro II', turnaroundMins: 45, gracePeriodMins: 10, allowUpsizeFallback: false, costForTwoPaise: 160000 });
    const a = await getPool().query(`SELECT actor, entity, data FROM audit_logs WHERE venue_id = $1 AND action = 'venue.updated'`, [ctx.fx.venueId]);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ actor: 'staff:manager@test.dev', entity: 'venue' });
    expect(a.rows[0].data.turnaroundMins).toBe(45);
  });

  it('PATCH validates input (turnaround multiple of 15, ranges)', async () => {
    const cookie = await login('manager');
    for (const body of [{ turnaroundMins: 40 }, { turnaroundMins: 0 }, { gracePeriodMins: 90 }, { costForOnePaise: -5 }, { name: 'x' }]) {
      const res = await req('PATCH', `/admin/venues/${ctx.fx.venueId}`, cookie, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect(await auditActions()).toEqual([]);
  });

  it('PATCH is manager-only and venue-scoped', async () => {
    const host = await req('PATCH', `/admin/venues/${ctx.fx.venueId}`, await login('host'), { name: 'Hacked' });
    expect(host.statusCode).toBe(403);
    const other = await req('PATCH', `/admin/venues/${ctx.fx.venueId}`, await otherVenueManager(), { name: 'Hacked' });
    expect(other.statusCode).toBe(403);
    const v = (await getPool().query('SELECT name FROM venues WHERE id = $1', [ctx.fx.venueId])).rows[0];
    expect(v.name).toBe('Test Bistro');
  });
});

// ---------------------------------------------------------------- E1-S4
describe('blackout', () => {
  it('any staff can toggle it; directory shows acceptingBookings=false; bookings untouched', async () => {
    const res0 = await insertReservation({ tableId: ctx.fx.tables['T-1'], partySize: 2, start: '2026-10-02T14:30:00Z', end: '2026-10-02T15:00:00Z' });
    const host = await login('host');

    const on_ = await req('POST', `/admin/venues/${ctx.fx.venueId}/blackout`, host, { enabled: true, reason: 'Private event' });
    expect(on_.statusCode).toBe(200);
    expect(on_.json()).toMatchObject({ blackout: true, blackoutReason: 'Private event', acceptingBookings: false });

    const card = ((await req('GET', '/venues?locality=cyber-city')).json() as VenueCard[]).find((v) => v.slug === 'test-bistro')!;
    expect(card.acceptingBookings).toBe(false);
    const r = (await getPool().query('SELECT status FROM reservations WHERE id = $1', [res0.id])).rows[0];
    expect(r.status).toBe('CONFIRMED');

    const off = await req('POST', `/admin/venues/${ctx.fx.venueId}/blackout`, host, { enabled: false });
    expect(off.json()).toMatchObject({ blackout: false, blackoutReason: null, acceptingBookings: true });

    const a = await getPool().query(`SELECT action, actor FROM audit_logs WHERE venue_id = $1 ORDER BY action`, [ctx.fx.venueId]);
    expect(a.rows).toEqual([
      { action: 'venue.blackout_off', actor: 'staff:host@test.dev' },
      { action: 'venue.blackout_on', actor: 'staff:host@test.dev' },
    ]);
  });

  it('validates the body and scopes by venue', async () => {
    expect((await req('POST', `/admin/venues/${ctx.fx.venueId}/blackout`, await login('host'), { enabled: 'yes' })).statusCode).toBe(400);
    expect((await req('POST', `/admin/venues/${ctx.fx.venueId}/blackout`, await login('other'), { enabled: true })).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------- E1-S5
describe('shifts', () => {
  const put = async (shifts: unknown, cookie?: string) =>
    req('PUT', `/admin/venues/${ctx.fx.venueId}/shifts`, cookie ?? (await login('manager')), { shifts });

  it('replaces all shifts atomically and audits', async () => {
    const res = await put([
      { dayOfWeek: 5, openTime: '18:00', closeTime: '23:30' },
      { dayOfWeek: 5, openTime: '09:00', closeTime: '16:00' },
      { dayOfWeek: 6, openTime: '18:00', closeTime: '01:00' },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { dayOfWeek: 5, openTime: '09:00', closeTime: '16:00' },
      { dayOfWeek: 5, openTime: '18:00', closeTime: '23:30' },
      { dayOfWeek: 6, openTime: '18:00', closeTime: '01:00' },
    ]);
    const n = (await getPool().query('SELECT count(*)::int AS n FROM operating_shifts WHERE venue_id = $1', [ctx.fx.venueId])).rows[0].n;
    expect(n).toBe(3);
    expect(await auditActions()).toEqual(['shifts.replaced']);
  });

  it('rejects overlapping shifts on the same day with 400 SHIFT_OVERLAP and keeps the old schedule', async () => {
    const res = await put([
      { dayOfWeek: 1, openTime: '12:00', closeTime: '16:00' },
      { dayOfWeek: 1, openTime: '15:45', closeTime: '22:00' },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SHIFT_OVERLAP');
    const n = (await getPool().query('SELECT count(*)::int AS n FROM operating_shifts WHERE venue_id = $1', [ctx.fx.venueId])).rows[0].n;
    expect(n).toBe(7);
  });

  it('counts the span of a cross-midnight shift, including Saturday into Sunday', async () => {
    expect((await put([
      { dayOfWeek: 2, openTime: '18:00', closeTime: '02:00' },
      { dayOfWeek: 3, openTime: '01:00', closeTime: '04:00' },
    ])).json().error.code).toBe('SHIFT_OVERLAP');
    expect((await put([
      { dayOfWeek: 6, openTime: '20:00', closeTime: '03:00' },
      { dayOfWeek: 0, openTime: '02:00', closeTime: '05:00' },
    ])).json().error.code).toBe('SHIFT_OVERLAP');
    // touching boundaries are fine
    expect((await put([
      { dayOfWeek: 2, openTime: '18:00', closeTime: '02:00' },
      { dayOfWeek: 3, openTime: '02:00', closeTime: '04:00' },
    ])).statusCode).toBe(200);
  });

  it('rejects off-grid times, equal open/close, and non-managers', async () => {
    expect((await put([{ dayOfWeek: 1, openTime: '12:10', closeTime: '16:00' }])).statusCode).toBe(400);
    expect((await put([{ dayOfWeek: 1, openTime: '12:00', closeTime: '12:00' }])).statusCode).toBe(400);
    expect((await put([{ dayOfWeek: 1, openTime: '12:00', closeTime: '16:00' }], await login('host'))).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------- E1-S6
describe('tables', () => {
  it('lists live tables with upcomingReservations counts', async () => {
    await insertReservation({ tableId: ctx.fx.tables['T-3'], partySize: 3, start: '2026-10-02T14:30:00Z', end: '2026-10-02T15:00:00Z' });
    await insertReservation({ tableId: ctx.fx.tables['T-3'], partySize: 3, start: '2026-10-02T11:00:00Z', end: '2026-10-02T11:30:00Z' }); // ended
    await insertReservation({ tableId: ctx.fx.tables['T-3'], partySize: 3, start: '2026-10-02T15:30:00Z', end: '2026-10-02T16:00:00Z', status: 'CANCELLED' });
    await insertReservation({ tableId: ctx.fx.tables['T-1'], partySize: 2, start: '2026-10-02T12:15:00Z', end: '2026-10-02T12:45:00Z', status: 'SEATED' });

    const res = await req('GET', `/admin/venues/${ctx.fx.venueId}/tables`, await login('host'));
    expect(res.statusCode).toBe(200);
    const tables = res.json() as DiningTableDto[];
    expect(tables.map((t) => t.tableNumber)).toEqual(['T-1', 'T-2', 'T-3', 'T-4']);
    const by = Object.fromEntries(tables.map((t) => [t.tableNumber, t]));
    expect(by['T-3']).toMatchObject({ minCapacity: 2, maxCapacity: 4, status: 'AVAILABLE', diningZone: 'MAIN', upcomingReservations: 1 });
    expect(by['T-1'].upcomingReservations).toBe(1);
    expect(by['T-2'].upcomingReservations).toBe(0);
    expect((await req('GET', `/admin/venues/${ctx.fx.venueId}/tables`, await login('other'))).statusCode).toBe(403);
  });

  it('creates a table (manager), audits and emits table.changed', async () => {
    const events: string[][] = [];
    const off = on('table.changed', (e) => void events.push(e.tableIds));
    const res = await req('POST', `/admin/venues/${ctx.fx.venueId}/tables`, await login('manager'), {
      tableNumber: 'P-1',
      diningZone: 'PATIO',
      minCapacity: 2,
      maxCapacity: 4,
    });
    off();
    expect(res.statusCode).toBe(200);
    const t = res.json() as DiningTableDto;
    expect(t).toMatchObject({ tableNumber: 'P-1', diningZone: 'PATIO', venueId: ctx.fx.venueId, status: 'AVAILABLE', upcomingReservations: 0 });
    expect(events).toEqual([[t.id]]);
    expect(await auditActions()).toEqual(['table.created']);
  });

  it('create validates capacity, duplicates and role', async () => {
    const mgr = await login('manager');
    const bad = await req('POST', `/admin/venues/${ctx.fx.venueId}/tables`, mgr, { tableNumber: 'X-1', minCapacity: 4, maxCapacity: 2 });
    expect(bad.statusCode).toBe(400);
    const dup = await req('POST', `/admin/venues/${ctx.fx.venueId}/tables`, mgr, { tableNumber: 'T-1', minCapacity: 1, maxCapacity: 2 });
    expect(dup.statusCode).toBe(409);
    const host = await req('POST', `/admin/venues/${ctx.fx.venueId}/tables`, await login('host'), { tableNumber: 'X-1', minCapacity: 1, maxCapacity: 2 });
    expect(host.statusCode).toBe(403);
    // the same number is fine at another venue
    const other = await req('POST', `/admin/venues/${ctx.fx.otherVenueId}/tables`, mgr, { tableNumber: 'T-1', minCapacity: 1, maxCapacity: 2 });
    expect(other.statusCode).toBe(200);
  });

  it('PATCH updates a table, audits and emits table.changed', async () => {
    const events: string[][] = [];
    const off = on('table.changed', (e) => void events.push(e.tableIds));
    const res = await req('PATCH', `/admin/tables/${ctx.fx.tables['T-2']}`, await login('manager'), { tableNumber: 'W-2', diningZone: 'BAR', maxCapacity: 3 });
    off();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tableNumber: 'W-2', diningZone: 'BAR', minCapacity: 1, maxCapacity: 3 });
    expect(events).toEqual([[ctx.fx.tables['T-2']]]);
    const a = (await getPool().query(`SELECT data FROM audit_logs WHERE action = 'table.updated'`)).rows[0];
    expect(a.data.before).toMatchObject({ tableNumber: 'T-2', maxCapacity: 2 });
    expect(a.data.after).toMatchObject({ tableNumber: 'W-2', maxCapacity: 3 });
  });

  it('PATCH rejects inconsistent capacity and duplicate numbers', async () => {
    const mgr = await login('manager');
    const cap = await req('PATCH', `/admin/tables/${ctx.fx.tables['T-3']}`, mgr, { maxCapacity: 1 }); // min stays 2
    expect(cap.statusCode).toBe(400);
    expect(cap.json().error.code).toBe('INVALID_CAPACITY');
    const dup = await req('PATCH', `/admin/tables/${ctx.fx.tables['T-3']}`, mgr, { tableNumber: 'T-4' });
    expect(dup.statusCode).toBe(409);
  });

  it('PATCH guards capacity changes that break a future booking (409 TABLE_HAS_BOOKINGS)', async () => {
    const T3 = ctx.fx.tables['T-3']; // 2–4
    const r = await insertReservation({ tableId: T3, partySize: 3, start: '2026-10-02T14:30:00Z', end: '2026-10-02T15:00:00Z' });
    const mgr = await login('manager');

    const down = await req('PATCH', `/admin/tables/${T3}`, mgr, { maxCapacity: 2 });
    expect(down.statusCode).toBe(409);
    expect(down.json().error.code).toBe('TABLE_HAS_BOOKINGS');
    expect(down.json().error.details.reservations).toEqual([{ id: r.id, partySize: 3, startAt: '2026-10-02T14:30:00.000Z' }]);

    const up = await req('PATCH', `/admin/tables/${T3}`, mgr, { minCapacity: 4 });
    expect(up.statusCode).toBe(409);
    expect(up.json().error.code).toBe('TABLE_HAS_BOOKINGS');

    // still fits the party of 3
    const ok = await req('PATCH', `/admin/tables/${T3}`, mgr, { maxCapacity: 3, minCapacity: 3 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().upcomingReservations).toBe(1);
  });

  it('PATCH ignores past and inactive reservations', async () => {
    const T3 = ctx.fx.tables['T-3'];
    await insertReservation({ tableId: T3, partySize: 4, start: '2026-10-02T11:00:00Z', end: '2026-10-02T11:30:00Z', status: 'COMPLETED' });
    await insertReservation({ tableId: T3, partySize: 4, start: '2026-10-02T11:45:00Z', end: '2026-10-02T12:15:00Z' }); // ended before now
    await insertReservation({ tableId: T3, partySize: 4, start: '2026-10-02T14:30:00Z', end: '2026-10-02T15:00:00Z', status: 'CANCELLED' });
    const res = await req('PATCH', `/admin/tables/${T3}`, await login('manager'), { maxCapacity: 2 });
    expect(res.statusCode).toBe(200);
  });

  it('PATCH/DELETE are manager-only and scoped to the table venue', async () => {
    const T1 = ctx.fx.tables['T-1'];
    expect((await req('PATCH', `/admin/tables/${T1}`, await login('host'), { maxCapacity: 3 })).statusCode).toBe(403);
    const om = await otherVenueManager();
    expect((await req('PATCH', `/admin/tables/${T1}`, om, { maxCapacity: 3 })).statusCode).toBe(403);
    expect((await req('DELETE', `/admin/tables/${T1}`, om)).statusCode).toBe(403);
    expect((await req('DELETE', `/admin/tables/not-a-uuid`, await login('manager'))).statusCode).toBe(404);
  });

  it('DELETE is refused while active/future bookings exist', async () => {
    const T4 = ctx.fx.tables['T-4'];
    await insertReservation({ tableId: T4, partySize: 2, start: '2026-10-02T14:30:00Z', end: '2026-10-02T15:00:00Z', status: 'REQUESTED' });
    const res = await req('DELETE', `/admin/tables/${T4}`, await login('manager'));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TABLE_HAS_BOOKINGS');
    const t = (await getPool().query('SELECT archived_at FROM dining_tables WHERE id = $1', [T4])).rows[0];
    expect(t.archived_at).toBeNull();
  });

  it('DELETE soft-deletes (archived_at), audits, emits, hides the table and frees its number', async () => {
    const T4 = ctx.fx.tables['T-4'];
    await insertReservation({ tableId: T4, partySize: 2, start: '2026-10-02T11:00:00Z', end: '2026-10-02T11:30:00Z', status: 'COMPLETED' });
    const events: string[][] = [];
    const off = on('table.changed', (e) => void events.push(e.tableIds));
    const mgr = await login('manager');
    const res = await req('DELETE', `/admin/tables/${T4}`, mgr);
    off();
    expect(res.statusCode).toBe(204);
    expect(events).toEqual([[T4]]);

    const row = (await getPool().query('SELECT archived_at FROM dining_tables WHERE id = $1', [T4])).rows[0];
    expect(new Date(row.archived_at).toISOString()).toBe('2026-10-02T12:30:00.000Z'); // clock.now()
    const list = (await req('GET', `/admin/venues/${ctx.fx.venueId}/tables`, mgr)).json() as DiningTableDto[];
    expect(list.map((t) => t.tableNumber)).not.toContain('T-4');
    expect(await auditActions()).toEqual(['table.archived']);

    expect((await req('DELETE', `/admin/tables/${T4}`, mgr)).statusCode).toBe(404);
    expect((await req('PATCH', `/admin/tables/${T4}`, mgr, { maxCapacity: 3 })).statusCode).toBe(404);
    const again = await req('POST', `/admin/venues/${ctx.fx.venueId}/tables`, mgr, { tableNumber: 'T-4', minCapacity: 2, maxCapacity: 4 });
    expect(again.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- E1-S7
describe('menu and audit', () => {
  it('lists the menu for staff and lets managers add items', async () => {
    const host = await login('host');
    const list = await req('GET', `/admin/venues/${ctx.fx.venueId}/menu`, host);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(4);
    expect(list.json().find((m: any) => m.name === 'Burrata')).toMatchObject({ category: 'STARTER', pricePaise: 65000, isAvailable: true });

    expect((await req('POST', `/admin/venues/${ctx.fx.venueId}/menu`, host, { name: 'Soup', category: 'STARTER', pricePaise: 100 })).statusCode).toBe(403);
    const mgr = await login('manager');
    const bad = await req('POST', `/admin/venues/${ctx.fx.venueId}/menu`, mgr, { name: 'Soup', category: 'SOUP', pricePaise: 100 });
    expect(bad.statusCode).toBe(400);
    const created = await req('POST', `/admin/venues/${ctx.fx.venueId}/menu`, mgr, { name: 'Minestrone', category: 'STARTER', pricePaise: 39500 });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: 'Minestrone', venueId: ctx.fx.venueId, pricePaise: 39500, isAvailable: true });
    expect((await req('GET', `/admin/venues/${ctx.fx.venueId}/menu`, host)).json()).toHaveLength(5);
    expect(await auditActions()).toEqual(['menu_item.created']);
    expect((await req('GET', `/admin/venues/${ctx.fx.venueId}/menu`, await login('other'))).statusCode).toBe(403);
  });

  it('lists the latest 100 audit entries for managers only', async () => {
    const pool = getPool();
    for (let i = 0; i < 105; i++) {
      await pool.query(
        `INSERT INTO audit_logs (venue_id, actor, action, entity, created_at) VALUES ($1,'system','test.entry','venue', $2)`,
        [ctx.fx.venueId, new Date(Date.parse('2020-01-01T00:00:00Z') + i * 60_000)],
      );
    }
    const mgr = await login('manager');
    await req('POST', `/admin/venues/${ctx.fx.venueId}/blackout`, mgr, { enabled: true });

    const res = await req('GET', `/admin/venues/${ctx.fx.venueId}/audit`, mgr);
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows).toHaveLength(100);
    expect(rows[0]).toMatchObject({ action: 'venue.blackout_on', actor: 'staff:manager@test.dev', entity: 'venue', entityId: ctx.fx.venueId });
    expect(rows[1].createdAt).toBe('2020-01-01T01:44:00.000Z'); // newest seeded entry

    expect((await req('GET', `/admin/venues/${ctx.fx.venueId}/audit`, await login('host'))).statusCode).toBe(403);
    expect((await req('GET', `/admin/venues/${ctx.fx.venueId}/audit`, await otherVenueManager())).statusCode).toBe(403);
  });
});
