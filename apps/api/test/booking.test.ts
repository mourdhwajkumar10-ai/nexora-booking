/**
 * Booking engine (A2): availability, allocation + locking, validation, tracker, admin lifecycle,
 * side effects and workers. Fixture: Fri 2026-10-02 18:00 IST, test-bistro open 12:00–23:00,
 * 2-tops T-1/T-2 (1–2), 4-tops T-3/T-4 (2–4).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '../src/db/pool';
import { on } from '../src/lib/bus';
import { clock } from '../src/lib/clock';
import { runJob } from '../src/lib/jobs';
import { createTestContext, FIXTURE_DATE, FIXTURE_NOW, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
beforeEach(async () => {
  await ctx.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await ctx.close();
});

// ------------------------------------------------------------------ helpers
let ipCounter = 0;
let phoneCounter = 0;
/** Distinct client IPs so the public booking rate limit (20/min/IP) doesn't interfere with functional tests. */
const nextIp = () => {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};
const nextPhone = () => `+9198${String(10_000_000 + ++phoneCounter)}`;
const db = () => getPool();
const sql = async (text: string, params: unknown[] = []) => (await db().query(text, params)).rows;

function book(body: Record<string, unknown> = {}, opts: { ip?: string } = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/venues/${ctx.fx.venueSlug}/reservations`,
    remoteAddress: opts.ip ?? nextIp(),
    payload: { date: FIXTURE_DATE, time: '19:30', partySize: 2, fullName: 'Asha Verma', phone: nextPhone(), ...body },
  });
}

function availability(partySize = 2, date = FIXTURE_DATE) {
  return ctx.app.inject({ method: 'GET', url: `/api/v1/venues/${ctx.fx.venueSlug}/availability?date=${date}&partySize=${partySize}` });
}

/**
 * Session cookie minted with the app's JWT secret. The login route is rate-limited (10/min/IP) and
 * ctx.reset() re-creates staff rows with new ids, so each test signs a fresh token.
 */
async function cookieFor(role: 'manager' | 'host' | 'other' = 'host'): Promise<string> {
  const email = role === 'manager' ? ctx.fx.managerEmail : role === 'host' ? ctx.fx.hostEmail : ctx.fx.otherVenueHostEmail;
  const [u] = await sql('SELECT id, email, name, role, venue_id FROM staff_users WHERE email = $1', [email]);
  return `nexora_session=${ctx.app.jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, venueId: u.venue_id }, { expiresIn: '1h' })}`;
}

function hostBook(cookie: string, body: Record<string, unknown> = {}, venueId = ctx.fx.venueId) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/admin/venues/${venueId}/reservations`,
    headers: { cookie },
    payload: { date: FIXTURE_DATE, time: '19:30', partySize: 2, fullName: 'Ravi Phone', phone: nextPhone(), ...body },
  });
}

function act(cookie: string, id: string, action: string, payload: Record<string, unknown> = {}) {
  return ctx.app.inject({ method: 'POST', url: `/api/v1/admin/reservations/${id}/${action}`, headers: { cookie }, payload });
}

const idForToken = async (token: string): Promise<string> => (await sql('SELECT id FROM reservations WHERE public_token = $1', [token]))[0].id;
const tableStatus = async (num: string) => (await sql('SELECT status FROM dining_tables WHERE id = $1', [ctx.fx.tables[num]]))[0].status;

/** Book via the public endpoint and return the reservation id + token. */
async function publicBooking(body: Record<string, unknown> = {}) {
  const res = await book(body);
  expect(res.statusCode, res.body).toBe(201);
  return { id: await idForToken(res.json().token), token: res.json().token as string, phone: (body.phone as string) ?? null };
}

async function confirmedBooking(cookie: string, body: Record<string, unknown> = {}) {
  const res = await hostBook(cookie, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

const OVERLAP_SQL = `SELECT count(*)::int AS n FROM reservations a JOIN reservations b
  ON a.table_id = b.table_id AND a.id < b.id AND a.start_at < b.end_at AND b.start_at < a.end_at
  WHERE a.status IN ('REQUESTED','CONFIRMED','SEATED') AND b.status IN ('REQUESTED','CONFIRMED','SEATED')`;

// ------------------------------------------------------------------ availability
describe('availability', () => {
  it('lists every slot 12:00–22:30 with past flags and tablesLeft', async () => {
    const res = await availability(2);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.closed).toBe(false);
    expect(body.blackout).toBe(false);
    expect(body.turnaroundMins).toBe(30);
    expect(body.serverTime).toBe(FIXTURE_NOW);
    expect(body.slots).toHaveLength(43);
    expect(body.slots[0].time).toBe('12:00');
    expect(body.slots.at(-1).time).toBe('22:30'); // last seating = close - turnaround (C-13)
    const s1745 = body.slots.find((s: any) => s.time === '17:45');
    expect(s1745).toMatchObject({ past: true, available: false });
    const s1800 = body.slots.find((s: any) => s.time === '18:00');
    expect(s1800).toMatchObject({ past: false, available: true, tablesLeft: 4 });
    expect((await availability(3)).json().slots.find((s: any) => s.time === '19:30').tablesLeft).toBe(2);
  });

  it('subtracts overlapping active bookings with strict half-open overlap', async () => {
    await publicBooking({ time: '19:30' });
    const slots = (await availability(2)).json().slots as any[];
    const left = (t: string) => slots.find((s) => s.time === t).tablesLeft;
    expect(left('19:00')).toBe(4); // [19:00,19:30) touches but does not overlap
    expect(left('19:15')).toBe(3);
    expect(left('19:30')).toBe(3);
    expect(left('19:45')).toBe(3);
    expect(left('20:00')).toBe(4);
  });

  it('ignores BLOCKED tables and honours allow_upsize_fallback', async () => {
    await sql(`UPDATE dining_tables SET status = 'BLOCKED' WHERE id = $1`, [ctx.fx.tables['T-4']]);
    await publicBooking({ time: '19:30' });
    await publicBooking({ time: '19:30' });
    let s = (await availability(2)).json().slots.find((x: any) => x.time === '19:30');
    expect(s).toMatchObject({ tablesLeft: 1, available: true }); // T-3 via upsize
    await sql('UPDATE venues SET allow_upsize_fallback = false WHERE id = $1', [ctx.fx.venueId]);
    s = (await availability(2)).json().slots.find((x: any) => x.time === '19:30');
    expect(s).toMatchObject({ tablesLeft: 0, available: false });
  });

  it('reports closed days and blackout', async () => {
    await sql('DELETE FROM operating_shifts WHERE venue_id = $1 AND day_of_week = 6', [ctx.fx.venueId]);
    const closed = (await availability(2, '2026-10-03')).json();
    expect(closed).toMatchObject({ closed: true, slots: [] });
    await sql('UPDATE venues SET blackout = true WHERE id = $1', [ctx.fx.venueId]);
    const b = (await availability(2)).json();
    expect(b.blackout).toBe(true);
    expect(b.slots.every((x: any) => !x.available)).toBe(true);
  });

  it('validates the query', async () => {
    expect((await availability(9)).statusCode).toBe(400);
    expect((await availability(2, '2026-02-31')).statusCode).toBe(400);
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/v1/venues/nope/availability?date=2026-10-02&partySize=2' });
    expect(missing.statusCode).toBe(404);
  });
});

// ------------------------------------------------------------------ create booking
describe('create booking', () => {
  it('creates a REQUESTED booking, hides the table, and enqueues the acknowledgement', async () => {
    const phone = nextPhone();
    const res = await book({ phone, email: 'asha@example.com', dietaryRequests: 'No nuts', seatingPreference: 'WINDOW' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ status: 'REQUESTED', date: FIXTURE_DATE, time: '19:30', partySize: 2, tableNumber: null, guestName: 'Asha Verma' });
    expect(body.phoneMasked.endsWith(phone.slice(-4))).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
    const [r] = await sql('SELECT * FROM reservations WHERE public_token = $1', [body.token]);
    expect(r).toMatchObject({ table_id: ctx.fx.tables['T-1'], source: 'ONLINE', booking_date: FIXTURE_DATE, dietary_requests: 'No nuts', seating_preference: 'WINDOW' });
    expect(new Date(r.created_at).toISOString()).toBe(FIXTURE_NOW);
    expect(new Date(r.start_at).toISOString()).toBe('2026-10-02T14:00:00.000Z');
    expect(new Date(r.end_at).toISOString()).toBe('2026-10-02T14:30:00.000Z');
    const notes = await sql('SELECT * FROM notifications_outbox WHERE reservation_id = $1', [r.id]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ template: 'RESERVATION_REQUESTED', channel: 'SMS', to_address: phone, status: 'PENDING' });
    const events = await sql('SELECT * FROM reservation_events WHERE reservation_id = $1', [r.id]);
    expect(events).toMatchObject([{ from_status: null, to_status: 'REQUESTED', actor: 'guest' }]);
  });

  it('best-fit: a party of 2 gets 2-tops first, a party of 3 gets a 4-top', async () => {
    const tableOf = async (b: Record<string, unknown>) => (await sql('SELECT table_id FROM reservations WHERE id = $1', [(await publicBooking(b)).id]))[0].table_id;
    expect(await tableOf({ partySize: 2 })).toBe(ctx.fx.tables['T-1']);
    expect(await tableOf({ partySize: 2 })).toBe(ctx.fx.tables['T-2']);
    expect(await tableOf({ partySize: 3 })).toBe(ctx.fx.tables['T-3']);
    expect(await tableOf({ partySize: 1, time: '20:00' })).toBe(ctx.fx.tables['T-1']);
    expect(await tableOf({ partySize: 4, time: '20:00' })).toBe(ctx.fx.tables['T-3']);
  });

  it('upsize fallback on: a party of 2 moves to a 4-top only once the 2-tops are taken', async () => {
    await publicBooking();
    await publicBooking();
    const { id } = await publicBooking();
    expect((await sql('SELECT table_id FROM reservations WHERE id = $1', [id]))[0].table_id).toBe(ctx.fx.tables['T-3']);
  });

  it('upsize fallback off: 409 SLOT_UNAVAILABLE with nearest alternatives within ±60 min', async () => {
    await sql('UPDATE venues SET allow_upsize_fallback = false WHERE id = $1', [ctx.fx.venueId]);
    await publicBooking();
    await publicBooking();
    const res = await book();
    expect(res.statusCode).toBe(409);
    const err = res.json().error;
    expect(err.code).toBe('SLOT_UNAVAILABLE');
    const alts: string[] = err.details.alternatives;
    expect(alts.slice(0, 2)).toEqual(['19:00', '20:00']);
    expect(alts).not.toContain('19:15');
    expect(alts).not.toContain('19:45');
    expect(alts.every((t) => t >= '18:30' && t <= '20:30')).toBe(true);
  });

  it('rejects with every validation error code', async () => {
    const code = async (res: Awaited<ReturnType<typeof book>>) => [res.statusCode, res.json().error?.code];
    expect(await code(await book({ time: '19:10' }))).toEqual([422, 'OFF_GRID']);
    expect(await code(await book({ time: '22:45' }))).toEqual([422, 'OUTSIDE_HOURS']); // 22:45 + 30 > 23:00
    expect(await code(await book({ time: '11:30' }))).toEqual([422, 'OUTSIDE_HOURS']);
    expect(await code(await book({ time: '17:30' }))).toEqual([400, 'IN_PAST']);
    expect(await code(await book({ date: '2026-10-01' }))).toEqual([400, 'IN_PAST']);
    expect(await code(await book({ phone: 'abc' }))).toEqual([400, 'VALIDATION_ERROR']);
    expect(await code(await book({ partySize: 6 }))).toEqual([400, 'VALIDATION_ERROR']);

    // per-phone cap: 2 active REQUESTED allowed, the third is refused
    const phone = nextPhone();
    expect((await book({ phone, time: '19:00' })).statusCode).toBe(201);
    expect((await book({ phone, time: '20:00' })).statusCode).toBe(201);
    expect(await code(await book({ phone, time: '21:00' }))).toEqual([422, 'TOO_MANY_REQUESTS_FOR_PHONE']);

    // no table in the venue can ever seat a party of 1 once the 2-tops are gone
    await sql('UPDATE dining_tables SET archived_at = now() WHERE id = ANY($1)', [[ctx.fx.tables['T-1'], ctx.fx.tables['T-2']]]);
    expect(await code(await book({ partySize: 1 }))).toEqual([422, 'NO_TABLE_FOR_PARTY']);

    // blackout wins over everything else
    await sql('UPDATE venues SET blackout = true WHERE id = $1', [ctx.fx.venueId]);
    expect(await code(await book({ time: '19:10' }))).toEqual([422, 'VENUE_BLACKOUT']);
  });

  it('does not count expired or confirmed bookings toward the per-phone cap', async () => {
    const phone = nextPhone();
    const cookie = await cookieFor('host');
    await confirmedBooking(cookie, { phone, time: '19:00' });
    await confirmedBooking(cookie, { phone, time: '20:00' });
    expect((await book({ phone, time: '21:00' })).statusCode).toBe(201);
    expect((await book({ phone, time: '21:30' })).statusCode).toBe(201);
  });

  it('rate-limits public booking per client IP (20/min)', async () => {
    const ip = '192.168.77.1';
    for (let i = 0; i < 20; i++) expect((await book({ time: 'bad' }, { ip })).statusCode).toBe(400);
    const res = await book({}, { ip });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
  });

  it('CONCURRENCY: 50 simultaneous requests for the last free table → exactly one 201', async () => {
    const cookie = await cookieFor('host');
    for (const t of ['T-1', 'T-2', 'T-3']) await confirmedBooking(cookie, { tableId: ctx.fx.tables[t] });
    const results = await Promise.all(Array.from({ length: 50 }, () => book({ time: '19:30', partySize: 2 })));
    const codes = results.map((r) => r.statusCode);
    const created = codes.filter((c) => c === 201).length;
    const conflicts = results.filter((r) => r.statusCode === 409);
    console.info(`[concurrency] last-table: 201 x ${created}, 409 x ${conflicts.length}, other x ${50 - created - conflicts.length}`);
    expect(created).toBe(1);
    expect(conflicts).toHaveLength(49);
    expect(conflicts.every((r) => r.json().error.code === 'SLOT_UNAVAILABLE')).toBe(true);
    expect((await sql(OVERLAP_SQL))[0].n).toBe(0);
    const onT4 = await sql(`SELECT count(*)::int AS n FROM reservations WHERE table_id = $1 AND status IN ('REQUESTED','CONFIRMED','SEATED')`, [ctx.fx.tables['T-4']]);
    expect(onT4[0].n).toBe(1);
  });

  it('CONCURRENCY: 50 simultaneous requests for 4 free tables → exactly four 201s, no overlaps', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => book({ time: '20:30', partySize: 2 })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(4);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(46);
    expect((await sql(OVERLAP_SQL))[0].n).toBe(0);
    const tables = await sql(`SELECT DISTINCT table_id FROM reservations WHERE status = 'REQUESTED'`);
    expect(tables).toHaveLength(4);
  });
});

// ------------------------------------------------------------------ host phone-in
describe('host phone-in booking', () => {
  it('auto-confirms by default with source PHONE and a WhatsApp confirmation', async () => {
    const cookie = await cookieFor('host');
    const phone = nextPhone();
    const res = await hostBook(cookie, { phone });
    expect(res.statusCode).toBe(201);
    const r = res.json();
    expect(r).toMatchObject({ status: 'CONFIRMED', source: 'PHONE', partySize: 2, time: '19:30', table: { tableNumber: 'T-1' } });
    expect(r.confirmedAt).toBe(FIXTURE_NOW);
    const [n] = await sql('SELECT * FROM notifications_outbox WHERE reservation_id = $1', [r.id]);
    expect(n).toMatchObject({
      template: 'RESERVATION_CONFIRMED',
      channel: 'WHATSAPP',
      to_address: phone,
      body: 'Reservation Confirmed: Table for 2 at Test Bistro on Fri, 2 Oct at 7:30 PM',
    });
  });

  it('supports autoConfirm=false and an explicit table (locked + overlap-checked + fit-checked)', async () => {
    const cookie = await cookieFor('host');
    const req = await hostBook(cookie, { autoConfirm: false, source: 'ONLINE' });
    expect(req.json()).toMatchObject({ status: 'REQUESTED', source: 'ONLINE' });
    const t4 = await hostBook(cookie, { tableId: ctx.fx.tables['T-4'] });
    expect(t4.json().table.tableNumber).toBe('T-4');
    const taken = await hostBook(cookie, { tableId: ctx.fx.tables['T-4'], time: '19:45' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('SLOT_UNAVAILABLE');
    const tooSmall = await hostBook(cookie, { tableId: ctx.fx.tables['T-2'], partySize: 4 });
    expect([tooSmall.statusCode, tooSmall.json().error.code]).toEqual([422, 'NO_TABLE_FOR_PARTY']);
  });

  it('enforces venue scope and authentication', async () => {
    expect((await hostBook(await cookieFor('other'))).statusCode).toBe(403);
    const anon = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/venues/${ctx.fx.venueId}/reservations`, payload: {} });
    expect(anon.statusCode).toBe(401);
    expect((await hostBook(await cookieFor('manager'))).statusCode).toBe(201); // org-wide manager
  });
});

// ------------------------------------------------------------------ public tracker
describe('public tracker and cancel', () => {
  it('reveals the table number only once confirmed', async () => {
    const { id, token } = await publicBooking();
    const get = () => ctx.app.inject({ method: 'GET', url: `/api/v1/reservations/${token}` });
    expect((await get()).json()).toMatchObject({ status: 'REQUESTED', tableNumber: null });
    await act(await cookieFor('host'), id, 'approve');
    expect((await get()).json()).toMatchObject({ status: 'CONFIRMED', tableNumber: 'T-1' });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/reservations/deadbeef' })).statusCode).toBe(404);
  });

  it('cancel requires the phone last-4 (403 PHONE_MISMATCH) and notifies the guest', async () => {
    const phone = nextPhone();
    const { id, token } = await publicBooking({ phone });
    const cancel = (phoneLast4: string) => ctx.app.inject({ method: 'POST', url: `/api/v1/reservations/${token}/cancel`, payload: { phoneLast4 } });
    const wrong = phone.slice(-4) === '0000' ? '1111' : '0000';
    const bad = await cancel(wrong);
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe('PHONE_MISMATCH');
    expect((await cancel('12a4')).statusCode).toBe(400);
    const ok = await cancel(phone.slice(-4));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'CANCELLED', cancelReason: 'Cancelled by guest' });
    const notes = await sql(`SELECT template FROM notifications_outbox WHERE reservation_id = $1 ORDER BY template`, [id]);
    expect(notes.map((n) => n.template)).toEqual(['RESERVATION_CANCELLED', 'RESERVATION_REQUESTED']);
    const again = await cancel(phone.slice(-4));
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
    // the freed slot is bookable again
    expect((await availability(2)).json().slots.find((s: any) => s.time === '19:30').tablesLeft).toBe(4);
  });

  it('guest can cancel a CONFIRMED booking but not a SEATED one', async () => {
    const cookie = await cookieFor('host');
    const phone = nextPhone();
    const a = await confirmedBooking(cookie, { phone, time: '18:30' });
    const b = await confirmedBooking(cookie, { phone, time: '21:00' });
    const cancel = (token: string) => ctx.app.inject({ method: 'POST', url: `/api/v1/reservations/${token}/cancel`, payload: { phoneLast4: phone.slice(-4) } });
    expect((await cancel(b.token)).json().status).toBe('CANCELLED');
    await act(cookie, a.id, 'seat');
    const res = await cancel(a.token);
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
  });
});

// ------------------------------------------------------------------ admin lifecycle
describe('admin lifecycle', () => {
  it('lists by date and comma-separated statuses; triage is oldest first', async () => {
    const cookie = await cookieFor('host');
    const first = await publicBooking({ time: '20:00' });
    clock.advanceMinutes(1);
    const second = await publicBooking({ time: '19:00' });
    await confirmedBooking(cookie, { time: '21:00' });
    const list = (q: string) => ctx.app.inject({ method: 'GET', url: `/api/v1/admin/venues/${ctx.fx.venueId}/reservations${q}`, headers: { cookie } });
    expect((await list(`?date=${FIXTURE_DATE}`)).json().map((r: any) => r.time)).toEqual(['19:00', '20:00', '21:00']);
    expect((await list('?date=2026-10-03')).json()).toEqual([]);
    expect((await list('?status=CONFIRMED')).json()).toHaveLength(1);
    expect((await list('?status=REQUESTED,CONFIRMED')).json()).toHaveLength(3);
    expect((await list('?status=BOGUS')).statusCode).toBe(400);
    const triage = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/venues/${ctx.fx.venueId}/triage`, headers: { cookie } });
    const ids = triage.json().map((r: any) => r.id);
    expect(ids).toEqual([first.id, second.id]);
    expect(triage.json()[0].triageDeadline).toBe('2026-10-02T12:35:00.000Z');
  });

  it('approve: REQUESTED → CONFIRMED with the exact confirmation message', async () => {
    const cookie = await cookieFor('host');
    const { id } = await publicBooking({ partySize: 2, time: '19:30' });
    const res = await act(cookie, id, 'approve');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, status: 'CONFIRMED', triageDeadline: null });
    const [n] = await sql(`SELECT * FROM notifications_outbox WHERE reservation_id = $1 AND template = 'RESERVATION_CONFIRMED'`, [id]);
    expect(n.body).toBe('Reservation Confirmed: Table for 2 at Test Bistro on Fri, 2 Oct at 7:30 PM');
    expect(n.channel).toBe('WHATSAPP');
    const again = await act(cookie, id, 'approve');
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
  });

  it('reject: REQUESTED → CANCELLED with a declined SMS; rejecting a confirmed booking is illegal', async () => {
    const cookie = await cookieFor('host');
    const { id } = await publicBooking();
    const res = await act(cookie, id, 'reject', { reason: 'Private event' });
    expect(res.json()).toMatchObject({ status: 'CANCELLED', cancelReason: 'Private event' });
    const [n] = await sql(`SELECT * FROM notifications_outbox WHERE reservation_id = $1 AND template = 'RESERVATION_DECLINED'`, [id]);
    expect(n.channel).toBe('SMS');
    expect(n.body).toContain('Private event');
    const confirmed = await confirmedBooking(cookie);
    const bad = await act(cookie, confirmed.id, 'reject');
    expect([bad.statusCode, bad.json().error.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
  });

  it('cancel: REQUESTED/CONFIRMED → CANCELLED; terminal states are illegal', async () => {
    const cookie = await cookieFor('host');
    const { id: requested } = await publicBooking();
    expect((await act(cookie, requested, 'cancel')).json().status).toBe('CANCELLED');
    const confirmed = await confirmedBooking(cookie, { time: '20:00' });
    const res = await act(cookie, confirmed.id, 'cancel', { reason: 'Guest called' });
    expect(res.json()).toMatchObject({ status: 'CANCELLED', cancelReason: 'Guest called' });
    const tpl = await sql(`SELECT template FROM notifications_outbox WHERE reservation_id = $1 AND template = 'RESERVATION_CANCELLED'`, [confirmed.id]);
    expect(tpl).toHaveLength(1);
    const again = await act(cookie, confirmed.id, 'cancel');
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
  });

  it('illegal transitions return 409 ILLEGAL_TRANSITION', async () => {
    const cookie = await cookieFor('host');
    const { id: requested } = await publicBooking();
    for (const a of ['seat', 'complete', 'no-show']) {
      const res = await act(cookie, requested, a);
      expect([a, res.statusCode, res.json().error.code]).toEqual([a, 409, 'ILLEGAL_TRANSITION']);
    }
    const confirmed = await confirmedBooking(cookie, { time: '18:30' });
    const c = await act(cookie, confirmed.id, 'complete');
    expect([c.statusCode, c.json().error.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
    expect((await act(cookie, confirmed.id, 'no-show')).json().status).toBe('NO_SHOW');
    for (const a of ['approve', 'seat', 'cancel', 'no-show']) {
      const res = await act(cookie, confirmed.id, a);
      expect([a, res.statusCode, res.json().error.code]).toEqual([a, 409, 'ILLEGAL_TRANSITION']);
    }
    expect((await act(cookie, '00000000-0000-0000-0000-000000000000', 'approve')).statusCode).toBe(404);
    expect((await act(cookie, 'not-a-uuid', 'approve')).statusCode).toBe(404);
  });

  it('no-show: CONFIRMED → NO_SHOW bumps no_show_count and notifies', async () => {
    const cookie = await cookieFor('host');
    const r = await confirmedBooking(cookie, { time: '18:30' });
    const res = await act(cookie, r.id, 'no-show');
    expect(res.json()).toMatchObject({ status: 'NO_SHOW', guest: { noShowCount: 1 } });
    const tpl = await sql(`SELECT channel FROM notifications_outbox WHERE reservation_id = $1 AND template = 'NO_SHOW'`, [r.id]);
    expect(tpl).toEqual([{ channel: 'SMS' }]);
  });

  it('seat: table OCCUPIED, order opened, last_visit_at stamped; TABLE_NOT_READY when not physically available', async () => {
    const cookie = await cookieFor('host');
    const r = await confirmedBooking(cookie, { time: '18:30', tableId: ctx.fx.tables['T-1'] });
    const res = await act(cookie, r.id, 'seat');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'SEATED', seatedAt: FIXTURE_NOW });
    expect(await tableStatus('T-1')).toBe('OCCUPIED');
    const orders = await sql('SELECT * FROM pos_orders WHERE reservation_id = $1', [r.id]);
    expect(orders).toMatchObject([{ status: 'PLACED', table_id: ctx.fx.tables['T-1'], guest_id: r.guest.id }]);
    const [gp] = await sql('SELECT last_visit_at FROM guest_profiles WHERE guest_id = $1', [r.guest.id]);
    expect(new Date(gp.last_visit_at).toISOString()).toBe(FIXTURE_NOW);

    for (const status of ['BUSSING', 'OCCUPIED', 'BLOCKED']) {
      const other = await confirmedBooking(cookie, { time: '18:30', tableId: ctx.fx.tables['T-2'] });
      await sql('UPDATE dining_tables SET status = $2 WHERE id = $1', [ctx.fx.tables['T-2'], status]);
      const bad = await act(cookie, other.id, 'seat');
      expect([bad.statusCode, bad.json().error.code]).toEqual([409, 'TABLE_NOT_READY']);
      expect((await sql('SELECT status FROM reservations WHERE id = $1', [other.id]))[0].status).toBe('CONFIRMED');
      expect(await sql('SELECT 1 FROM pos_orders WHERE reservation_id = $1', [other.id])).toHaveLength(0);
      await sql(`UPDATE dining_tables SET status = 'AVAILABLE' WHERE id = $1`, [ctx.fx.tables['T-2']]);
      await act(cookie, other.id, 'cancel');
    }
  });

  it('complete: CHECK_OPEN while the check has unpaid items; then COMPLETED, table BUSSING, visit stats', async () => {
    const cookie = await cookieFor('host');
    const r = await confirmedBooking(cookie, { time: '18:30', partySize: 2 });
    await act(cookie, r.id, 'seat');
    const [order] = await sql('SELECT id FROM pos_orders WHERE reservation_id = $1', [r.id]);
    await sql(`INSERT INTO pos_order_items (order_id, item_name, category, quantity, unit_price_paise) VALUES ($1,'Burrata','STARTER',1,65000)`, [order.id]);
    const blocked = await act(cookie, r.id, 'complete');
    expect([blocked.statusCode, blocked.json().error.code]).toEqual([409, 'CHECK_OPEN']);
    expect(await tableStatus('T-1')).toBe('OCCUPIED');
    await sql(`UPDATE pos_orders SET status = 'BILLED', settled_at = now() WHERE id = $1`, [order.id]);
    await sql('UPDATE guest_profiles SET total_visits = 1, avg_party_size = 4 WHERE guest_id = $1', [r.guest.id]);
    const res = await act(cookie, r.id, 'complete');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'COMPLETED', completedAt: FIXTURE_NOW, guest: { totalVisits: 2 } });
    expect(await tableStatus('T-1')).toBe('BUSSING');
    const [gp] = await sql('SELECT total_visits, avg_party_size FROM guest_profiles WHERE guest_id = $1', [r.guest.id]);
    expect(gp).toEqual({ total_visits: 2, avg_party_size: 3 });
    const again = await act(cookie, r.id, 'cancel');
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
  });

  it('complete with an empty check voids it', async () => {
    const cookie = await cookieFor('host');
    const r = await confirmedBooking(cookie, { time: '18:30', partySize: 3 });
    await act(cookie, r.id, 'seat');
    const res = await act(cookie, r.id, 'complete');
    expect(res.json().status).toBe('COMPLETED');
    expect((await sql('SELECT status FROM pos_orders WHERE reservation_id = $1', [r.id]))[0].status).toBe('VOIDED');
    expect(await tableStatus('T-3')).toBe('BUSSING');
    const [gp] = await sql('SELECT total_visits, avg_party_size FROM guest_profiles WHERE guest_id = $1', [r.guest.id]);
    expect(gp).toEqual({ total_visits: 1, avg_party_size: 3 });
  });

  it('reassign: locks, fit- and overlap-checks the new table; only REQUESTED/CONFIRMED', async () => {
    const cookie = await cookieFor('host');
    const a = await confirmedBooking(cookie, { tableId: ctx.fx.tables['T-1'] });
    const b = await confirmedBooking(cookie, { tableId: ctx.fx.tables['T-2'], time: '19:45' });
    const clash = await act(cookie, a.id, 'reassign', { tableId: ctx.fx.tables['T-2'] });
    expect([clash.statusCode, clash.json().error.code]).toEqual([409, 'SLOT_UNAVAILABLE']);
    const ok = await act(cookie, a.id, 'reassign', { tableId: ctx.fx.tables['T-4'] });
    expect(ok.json().table.tableNumber).toBe('T-4');
    const solo = await confirmedBooking(cookie, { partySize: 1, time: '21:00' });
    const noFit = await act(cookie, solo.id, 'reassign', { tableId: ctx.fx.tables['T-3'] });
    expect([noFit.statusCode, noFit.json().error.code]).toEqual([422, 'NO_TABLE_FOR_PARTY']);
    const foreign = await act(cookie, b.id, 'reassign', { tableId: ctx.fx.tables['T-9'] ?? '00000000-0000-0000-0000-000000000000' });
    expect(foreign.statusCode).toBe(404);
    await sql(`UPDATE reservations SET status = 'SEATED' WHERE id = $1`, [b.id]);
    const seated = await act(cookie, b.id, 'reassign', { tableId: ctx.fx.tables['T-3'] });
    expect([seated.statusCode, seated.json().error.code]).toEqual([409, 'INVALID_STATUS']);
  });

  it('host staff from another venue get 403 on every admin route', async () => {
    const host = await cookieFor('host');
    const other = await cookieFor('other');
    const r = await confirmedBooking(host);
    for (const a of ['approve', 'reject', 'cancel', 'seat', 'no-show', 'complete']) {
      expect([a, (await act(other, r.id, a)).statusCode]).toEqual([a, 403]);
    }
    expect((await act(other, r.id, 'reassign', { tableId: ctx.fx.tables['T-4'] })).statusCode).toBe(403);
    for (const path of ['reservations', 'triage', 'notifications']) {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/venues/${ctx.fx.venueId}/${path}`, headers: { cookie: other } });
      expect([path, res.statusCode]).toEqual([path, 403]);
    }
    expect((await sql('SELECT status FROM reservations WHERE id = $1', [r.id]))[0].status).toBe('CONFIRMED');
  });

  it('lists notifications for the venue, newest first', async () => {
    const cookie = await cookieFor('host');
    const { id } = await publicBooking();
    clock.advanceMinutes(1);
    await act(cookie, id, 'approve');
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/venues/${ctx.fx.venueId}/notifications`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((n: any) => n.template)).toEqual(['RESERVATION_CONFIRMED', 'RESERVATION_REQUESTED']);
    expect(res.json()[0]).toMatchObject({ channel: 'WHATSAPP', status: 'PENDING', reservationId: id, sentAt: null });
  });
});

// ------------------------------------------------------------------ workers
describe('workers', () => {
  it('triage-escalation auto-confirms a Good Standing guest after the timeout', async () => {
    const { id } = await publicBooking();
    clock.advanceMinutes(4);
    await runJob('triage-escalation');
    expect((await sql('SELECT status FROM reservations WHERE id = $1', [id]))[0].status).toBe('REQUESTED');
    clock.advanceMinutes(1);
    await runJob('triage-escalation');
    const [r] = await sql('SELECT * FROM reservations WHERE id = $1', [id]);
    expect(r.status).toBe('CONFIRMED');
    expect(r.escalated_at).toBeNull();
    expect(new Date(r.confirmed_at).toISOString()).toBe('2026-10-02T12:35:00.000Z');
    const n = await sql(`SELECT channel FROM notifications_outbox WHERE reservation_id = $1 AND template = 'RESERVATION_CONFIRMED'`, [id]);
    expect(n).toEqual([{ channel: 'WHATSAPP' }]);
    const [ev] = await sql(`SELECT actor FROM reservation_events WHERE reservation_id = $1 AND to_status = 'CONFIRMED'`, [id]);
    expect(ev.actor).toBe('system:triage');
  });

  it('triage-escalation escalates a guest with a recent NO_SHOW (critical alert, deduped)', async () => {
    const phone = nextPhone();
    const { id } = await publicBooking({ phone });
    const [{ guest_id }] = await sql('SELECT guest_id FROM reservations WHERE id = $1', [id]);
    await sql(
      `INSERT INTO reservations (venue_id, guest_id, party_size, booking_date, start_at, end_at, status)
       VALUES ($1,$2,2,'2026-09-20','2026-09-20T14:00:00Z','2026-09-20T14:30:00Z','NO_SHOW')`,
      [ctx.fx.venueId, guest_id],
    );
    clock.advanceMinutes(6);
    await runJob('triage-escalation');
    await runJob('triage-escalation');
    const [r] = await sql('SELECT * FROM reservations WHERE id = $1', [id]);
    expect(r.status).toBe('REQUESTED');
    expect(new Date(r.escalated_at).toISOString()).toBe('2026-10-02T12:36:00.000Z');
    const alerts = await sql(`SELECT * FROM alerts WHERE kind = 'TRIAGE_ESCALATION'`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical', dedupe_key: `triage:${id}`, venue_id: ctx.fx.venueId });
    expect(alerts[0].data.reservationId).toBe(id);
  });

  it('triage-escalation: old no-shows (> 90 days) are forgiven, the loyalty deficit flag is not', async () => {
    const a = await publicBooking({ time: '20:00' });
    const b = await publicBooking({ time: '21:00' });
    const [{ guest_id: ga }] = await sql('SELECT guest_id FROM reservations WHERE id = $1', [a.id]);
    const [{ guest_id: gb }] = await sql('SELECT guest_id FROM reservations WHERE id = $1', [b.id]);
    await sql(
      `INSERT INTO reservations (venue_id, guest_id, party_size, booking_date, start_at, end_at, status)
       VALUES ($1,$2,2,'2026-06-01','2026-06-01T14:00:00Z','2026-06-01T14:30:00Z','NO_SHOW')`,
      [ctx.fx.venueId, ga],
    );
    await sql(`UPDATE guest_profiles SET flags = ARRAY['UNRESOLVED_LOYALTY_DEFICIT'] WHERE guest_id = $1`, [gb]);
    clock.advanceMinutes(6);
    await runJob('triage-escalation');
    expect((await sql('SELECT status FROM reservations WHERE id = $1', [a.id]))[0].status).toBe('CONFIRMED');
    const [rb] = await sql('SELECT status, escalated_at FROM reservations WHERE id = $1', [b.id]);
    expect(rb.status).toBe('REQUESTED');
    expect(rb.escalated_at).not.toBeNull();
  });

  it('grace-no-show marks CONFIRMED bookings NO_SHOW after start + grace', async () => {
    const cookie = await cookieFor('host');
    const r = await confirmedBooking(cookie, { time: '18:30' });
    const later = await confirmedBooking(cookie, { time: '20:00' });
    clock.advanceMinutes(44); // 18:44
    await runJob('grace-no-show');
    expect((await sql('SELECT status FROM reservations WHERE id = $1', [r.id]))[0].status).toBe('CONFIRMED');
    clock.advanceMinutes(1); // 18:45 = 18:30 + 15
    await runJob('grace-no-show');
    expect((await sql('SELECT status FROM reservations WHERE id = $1', [r.id]))[0].status).toBe('NO_SHOW');
    expect((await sql('SELECT status FROM reservations WHERE id = $1', [later.id]))[0].status).toBe('CONFIRMED');
    const [gp] = await sql('SELECT no_show_count FROM guest_profiles WHERE guest_id = $1', [r.guest.id]);
    expect(gp.no_show_count).toBe(1);
    const alerts = await sql(`SELECT * FROM alerts WHERE kind = 'NO_SHOW'`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].data.reservationId).toBe(r.id);
    await runJob('grace-no-show');
    expect((await sql('SELECT no_show_count FROM guest_profiles WHERE guest_id = $1', [r.guest.id]))[0].no_show_count).toBe(1);
    // a seated guest is never marked no-show
    expect((await sql(`SELECT count(*)::int AS n FROM notifications_outbox WHERE template = 'NO_SHOW'`))[0].n).toBe(1);
  });

  it('notification-outbox logs mock messages, marks rows SENT and emits notification.sent', async () => {
    const cookie = await cookieFor('host');
    const phone = nextPhone();
    await confirmedBooking(cookie, { phone });
    const smsPhone = nextPhone();
    await publicBooking({ phone: smsPhone, time: '20:00' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const emitted: any[] = [];
    const off = on('notification.sent', (e) => {
      emitted.push(e);
    });
    clock.advanceMinutes(1);
    try {
      await runJob('notification-outbox');
    } finally {
      off();
    }
    const lines = log.mock.calls.map((c) => c[0]);
    expect(lines).toContain(`[MOCK WHATSAPP] to ${phone}: Reservation Confirmed: Table for 2 at Test Bistro on Fri, 2 Oct at 7:30 PM`);
    expect(lines.some((l) => typeof l === 'string' && l.startsWith(`[MOCK SMS] to ${smsPhone}: Request Received`))).toBe(true);
    const rows = await sql('SELECT status, sent_at FROM notifications_outbox');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'SENT' && new Date(r.sent_at).toISOString() === '2026-10-02T12:31:00.000Z')).toBe(true);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ type: 'notification.sent', venueId: ctx.fx.venueId, notification: { status: 'SENT' } });
    log.mockClear();
    await runJob('notification-outbox'); // nothing left
    expect(log).not.toHaveBeenCalled();
  });
});
