import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FloorSnapshot, FloorTable } from '@nexora/shared';
import { getPool } from '../src/db/pool';
import { clock } from '../src/lib/clock';
import { runJob } from '../src/lib/jobs';
import { createTestContext, FIXTURE_DATE, type TestContext } from './helpers';

let ctx: TestContext;
let cookie: string;
beforeAll(async () => {
  ctx = await createTestContext();
});
beforeEach(async () => {
  await ctx.reset();
  cookie = await ctx.login('host');
});
afterAll(async () => {
  await ctx.close();
});

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, c = cookie) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: { cookie: c }, payload: payload as any });

let phoneSeq = 0;
/** Insert a guest + reservation directly (the booking module is built in parallel). `at` is IST "HH:mm" on the fixture date. */
async function insertReservation(o: { table: string; at: string; status?: string; party?: number; first?: string; last?: string; mins?: number }) {
  const pool = getPool();
  const g = (
    await pool.query(`INSERT INTO guests (first_name, last_name, phone_number) VALUES ($1,$2,$3) RETURNING id`, [
      o.first ?? 'Meera',
      o.last ?? 'Nair',
      `+9198${String(++phoneSeq).padStart(8, '0')}`,
    ])
  ).rows[0];
  await pool.query('INSERT INTO guest_profiles (guest_id) VALUES ($1)', [g.id]);
  const start = new Date(`${FIXTURE_DATE}T${o.at}:00+05:30`);
  const end = new Date(start.getTime() + (o.mins ?? 30) * 60_000);
  const r = (
    await pool.query(
      `INSERT INTO reservations (venue_id, table_id, guest_id, party_size, booking_date, start_at, end_at, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PHONE') RETURNING *`,
      [ctx.fx.venueId, ctx.fx.tables[o.table], g.id, o.party ?? 2, FIXTURE_DATE, start, end, o.status ?? 'CONFIRMED'],
    )
  ).rows[0];
  return { id: r.id as string, guestId: g.id as string };
}

async function floor(): Promise<FloorSnapshot> {
  const res = await api('GET', `/admin/venues/${ctx.fx.venueId}/floor`);
  expect(res.statusCode).toBe(200);
  return res.json();
}
const byNum = (s: FloorSnapshot, n: string): FloorTable => s.tables.find((t) => t.tableNumber === n)!;

async function walkIn(table: string, body: Record<string, unknown> = {}) {
  return api('POST', `/admin/venues/${ctx.fx.venueId}/walk-ins`, { partySize: 2, tableId: ctx.fx.tables[table], ...body });
}

const setIst = (hhmm: string) => clock.set(`${FIXTURE_DATE}T${hhmm}:00+05:30`);

describe('floor snapshot', () => {
  it('derives RESERVED only inside [start - turnaround, start + grace)', async () => {
    const r = await insertReservation({ table: 'T-4', at: '18:15', first: 'John', last: 'Doe' });
    let s = await floor();
    expect(byNum(s, 'T-4').physicalStatus).toBe('AVAILABLE');
    expect(byNum(s, 'T-4').floorStatus).toBe('RESERVED');
    expect(byNum(s, 'T-4').next).toMatchObject({ reservationId: r.id, guestName: 'John Doe', status: 'CONFIRMED' });
    expect(s.counts).toEqual({ AVAILABLE: 3, RESERVED: 1, OCCUPIED: 0, BUSSING: 0, BLOCKED: 0 });
    expect(s.serverTime).toBe('2026-10-02T12:30:00.000Z');

    setIst('17:30');
    s = await floor();
    expect(byNum(s, 'T-4').floorStatus).toBe('AVAILABLE');
    expect(byNum(s, 'T-4').next?.reservationId).toBe(r.id);

    setIst('18:29');
    expect(byNum(await floor(), 'T-4').floorStatus).toBe('RESERVED'); // inside grace
    setIst('18:30');
    expect(byNum(await floor(), 'T-4').floorStatus).toBe('AVAILABLE'); // start + grace is exclusive
  });

  it('does not derive RESERVED from REQUESTED bookings, and BLOCKED wins', async () => {
    await insertReservation({ table: 'T-3', at: '18:15', status: 'REQUESTED' });
    await insertReservation({ table: 'T-4', at: '18:15' });
    await getPool().query(`UPDATE dining_tables SET status = 'BLOCKED' WHERE id = $1`, [ctx.fx.tables['T-4']]);
    const s = await floor();
    expect(byNum(s, 'T-3').floorStatus).toBe('AVAILABLE');
    expect(byNum(s, 'T-3').next?.status).toBe('REQUESTED');
    expect(byNum(s, 'T-4').floorStatus).toBe('BLOCKED');
    expect(s.covers.capacity).toBe(2 + 2 + 4); // T-4 blocked
  });

  it('shows the seated party, order summary, covers and dwell levels over time', async () => {
    const w = await walkIn('T-3', { partySize: 3, guestName: 'Kabir Singh', phone: '+919810000003' });
    expect(w.statusCode).toBe(201);
    await getPool().query(`UPDATE guest_profiles SET allergies = 'Gluten' WHERE guest_id = $1`, [w.json().guest.id]);
    await getPool().query(`INSERT INTO guest_tags (guest_id, tag_name) VALUES ($1, 'SLOW_PACING')`, [w.json().guest.id]);
    const order = (await api('GET', `/admin/tables/${ctx.fx.tables['T-3']}/order`)).json();
    await api('POST', `/admin/orders/${order.id}/items`, { itemName: 'Soda', category: 'BEVERAGE', quantity: 2, unitPricePaise: 19500 });

    let s = await floor();
    const t3 = byNum(s, 'T-3');
    expect(t3.floorStatus).toBe('OCCUPIED');
    expect(t3.current).toMatchObject({ guestName: 'Kabir Singh', partySize: 3, source: 'WALK_IN', tags: ['SLOW_PACING'], allergies: 'Gluten' });
    expect(t3.order).toMatchObject({ id: order.id, status: 'PLACED', itemCount: 2, netPaise: 39000 });
    expect(t3.dwell).toMatchObject({ elapsedSecs: 0, level: 'normal' });
    expect(s.covers).toEqual({ seated: 3, capacity: 12 });
    expect(s.counts.OCCUPIED).toBe(1);

    clock.advanceMinutes(29);
    expect(byNum(await floor(), 'T-3').dwell?.level).toBe('normal');
    clock.advanceMinutes(1);
    s = await floor();
    expect(byNum(s, 'T-3').dwell).toMatchObject({ elapsedSecs: 1800, level: 'amber' });
    clock.advanceMinutes(15);
    expect(byNum(await floor(), 'T-3').dwell).toMatchObject({ elapsedSecs: 2700, level: 'red' });
  });

  it('sorts by zone then natural table number', async () => {
    await getPool().query(
      `INSERT INTO dining_tables (venue_id, table_number, dining_zone, min_capacity, max_capacity) VALUES
       ($1,'T-10','MAIN',1,2),($1,'P-1','PATIO',1,2),($1,'B-1','BAR',1,2)`,
      [ctx.fx.venueId],
    );
    const s = await floor();
    expect(s.tables.map((t) => t.tableNumber)).toEqual(['T-1', 'T-2', 'T-3', 'T-4', 'T-10', 'P-1', 'B-1']);
  });

  it('enforces venue access and auth', async () => {
    expect((await api('GET', `/admin/venues/${ctx.fx.venueId}/floor`, undefined, await ctx.login('other'))).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/venues/${ctx.fx.venueId}/floor` })).statusCode).toBe(401);
    expect((await api('GET', `/admin/venues/${ctx.fx.venueId}/floor`, undefined, await ctx.login('manager'))).statusCode).toBe(200);
  });
});

describe('walk-ins', () => {
  const MSG_1830 = 'Collision Alert: Table T-4 reserved for Meera Nair at 6:30 PM. Dwell time exceeds arrival threshold.';

  it('flags the doc example (booking at 18:30, now 18:00) and suggests other tables', async () => {
    const r = await insertReservation({ table: 'T-4', at: '18:30' });
    const res = await api('POST', `/admin/venues/${ctx.fx.venueId}/walk-ins/check`, { partySize: 3, tableId: ctx.fx.tables['T-4'] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toBe(MSG_1830);
    expect(body.conflicts).toEqual([
      { tableId: ctx.fx.tables['T-4'], tableNumber: 'T-4', reservationId: r.id, guestName: 'Meera Nair', startAt: '2026-10-02T13:00:00.000Z' },
    ]);
    expect(body.suggestions).toEqual([{ tableId: ctx.fx.tables['T-3'], tableNumber: 'T-3', maxCapacity: 4 }]);

    const two = (await api('POST', `/admin/venues/${ctx.fx.venueId}/walk-ins/check`, { partySize: 2 })).json();
    expect(two.ok).toBe(true);
    expect(two.suggestions.map((s: any) => s.tableNumber)).toEqual(['T-1', 'T-2', 'T-3']);
  });

  it('uses the turnaround + 15 window: 7:15 PM booking collides with an 18:45 walk-in, 18:45 booking does not at 18:00', async () => {
    await insertReservation({ table: 'T-4', at: '18:45', first: 'John', last: 'Doe' });
    let body = (await api('POST', `/admin/venues/${ctx.fx.venueId}/walk-ins/check`, { partySize: 2, tableId: ctx.fx.tables['T-4'] })).json();
    expect(body.ok).toBe(true);
    expect(body.message).toBeNull();

    await getPool().query(`DELETE FROM reservations`);
    await insertReservation({ table: 'T-4', at: '19:15', first: 'John', last: 'Doe' });
    setIst('18:45');
    body = (await api('POST', `/admin/venues/${ctx.fx.venueId}/walk-ins/check`, { partySize: 2, tableId: ctx.fx.tables['T-4'] })).json();
    expect(body.ok).toBe(false);
    expect(body.message).toBe('Collision Alert: Table T-4 reserved for John Doe at 7:15 PM. Dwell time exceeds arrival threshold.');
  });

  it('seats a walk-in: SEATED reservation, OCCUPIED table, PLACED order', async () => {
    const res = await walkIn('T-1', { guestName: 'Aarav Mehta', phone: '+919810000001' });
    expect(res.statusCode).toBe(201);
    const r = res.json();
    expect(r).toMatchObject({
      status: 'SEATED',
      source: 'WALK_IN',
      partySize: 2,
      date: FIXTURE_DATE,
      time: '18:00',
      startAt: '2026-10-02T12:30:00.000Z',
      endAt: '2026-10-02T13:00:00.000Z',
      seatedAt: '2026-10-02T12:30:00.000Z',
      table: { id: ctx.fx.tables['T-1'], tableNumber: 'T-1' },
      guest: { name: 'Aarav Mehta', phone: '+919810000001' },
    });
    const order = await api('GET', `/admin/tables/${ctx.fx.tables['T-1']}/order`);
    expect(order.statusCode).toBe(200);
    expect(order.json()).toMatchObject({ status: 'PLACED', reservationId: r.id, guestName: 'Aarav Mehta', items: [] });
    const t1 = byNum(await floor(), 'T-1');
    expect(t1.physicalStatus).toBe('OCCUPIED');
    const ev = await getPool().query('SELECT from_status, to_status FROM reservation_events WHERE reservation_id = $1', [r.id]);
    expect(ev.rows).toEqual([{ from_status: null, to_status: 'SEATED' }]);

    // Same phone again resolves to the same guest; table now not ready.
    const again = await walkIn('T-1', { phone: '+919810000001' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('TABLE_NOT_READY');
  });

  it('creates an anonymous guest when no phone is given', async () => {
    const a = (await walkIn('T-1')).json();
    expect(a.guest.name).toBe('Walk-in');
    expect(a.guest.phone).toMatch(/^walkin:[0-9a-f]{24}$/);
    const b = (await walkIn('T-2', { guestName: 'Tall Guy' })).json();
    expect(b.guest.name).toBe('Tall Guy');
    expect(b.guest.id).not.toBe(a.guest.id);
  });

  it('rejects a colliding walk-in with 409 unless override (audited)', async () => {
    await insertReservation({ table: 'T-4', at: '18:30' });
    const res = await walkIn('T-4', { partySize: 3 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'WALK_IN_COLLISION', message: MSG_1830 });
    expect(res.json().error.details.suggestions.map((s: any) => s.tableNumber)).toEqual(['T-3']);
    expect(res.json().error.details.conflicts).toHaveLength(1);

    // Override: [18:00,18:30) touches but does not overlap [18:30,19:00) -> allowed.
    const ok = await walkIn('T-4', { partySize: 3, override: true });
    expect(ok.statusCode).toBe(201);
    const audit = await getPool().query(`SELECT * FROM audit_logs WHERE action = 'walk_in.override'`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ entity_id: ctx.fx.tables['T-4'], actor: 'staff:host@test.dev' });
  });

  it('override cannot double-book a physically overlapping booking (EXCLUDE → WALK_IN_COLLISION)', async () => {
    await insertReservation({ table: 'T-4', at: '18:15' });
    const res = await walkIn('T-4', { partySize: 3, override: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('WALK_IN_COLLISION');
    expect(res.json().error.message).toContain('Override cannot double-book');
    const t = await getPool().query('SELECT status FROM dining_tables WHERE id = $1', [ctx.fx.tables['T-4']]);
    expect(t.rows[0].status).toBe('AVAILABLE');
    expect((await getPool().query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'walk_in.override'`)).rows[0].n).toBe(0);
  });

  it('rejects other venues and oversized parties', async () => {
    expect((await api('POST', `/admin/venues/${ctx.fx.venueId}/walk-ins`, { partySize: 2, tableId: ctx.fx.tables['T-1'] }, await ctx.login('other'))).statusCode).toBe(403);
    const big = await walkIn('T-1', { partySize: 4 });
    expect(big.statusCode).toBe(422);
    const other = await api('POST', `/admin/venues/${ctx.fx.otherVenueId}/walk-ins`, { partySize: 2, tableId: ctx.fx.tables['T-1'] }, await ctx.login('manager'));
    expect(other.statusCode).toBe(404);
  });
});

describe('table status', () => {
  const setStatus = (table: string, status: string, c?: string) => api('POST', `/admin/tables/${ctx.fx.tables[table]}/status`, { status, reason: 'test' }, c);

  it('blocks and unblocks with audit rows', async () => {
    const res = await setStatus('T-2', 'BLOCKED');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tableNumber: 'T-2', physicalStatus: 'BLOCKED', floorStatus: 'BLOCKED' });
    const un = await setStatus('T-2', 'AVAILABLE');
    expect(un.json()).toMatchObject({ physicalStatus: 'AVAILABLE', floorStatus: 'AVAILABLE' });
    const audit = await getPool().query(`SELECT data FROM audit_logs WHERE action = 'table.status' ORDER BY created_at, data->>'to' DESC`);
    expect(audit.rows.map((r) => [r.data.from, r.data.to])).toEqual(
      expect.arrayContaining([
        ['AVAILABLE', 'BLOCKED'],
        ['BLOCKED', 'AVAILABLE'],
      ]),
    );
    expect(audit.rows).toHaveLength(2);
  });

  it('marks a bussing table clean; returns RESERVED if a booking is imminent', async () => {
    await getPool().query(`UPDATE dining_tables SET status = 'BUSSING' WHERE id = $1`, [ctx.fx.tables['T-3']]);
    await insertReservation({ table: 'T-3', at: '18:15' });
    const res = await setStatus('T-3', 'AVAILABLE');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ physicalStatus: 'AVAILABLE', floorStatus: 'RESERVED' });
  });

  it('refuses to block or bus an occupied table, and FSM violations are 409', async () => {
    expect((await walkIn('T-1')).statusCode).toBe(201);
    const block = await setStatus('T-1', 'BLOCKED');
    expect(block.statusCode).toBe(409);
    expect(block.json().error.code).toBe('TABLE_OCCUPIED');
    expect((await setStatus('T-1', 'BUSSING')).json().error.code).toBe('TABLE_OCCUPIED');
    const bad = await setStatus('T-2', 'BUSSING'); // AVAILABLE -> BUSSING not in FSM
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('checks venue access and ids', async () => {
    expect((await setStatus('T-2', 'BLOCKED', await ctx.login('other'))).statusCode).toBe(403);
    expect((await api('POST', `/admin/tables/not-a-uuid/status`, { status: 'BLOCKED' })).statusCode).toBe(404);
    expect((await api('POST', `/admin/tables/${ctx.fx.tables['T-2']}/status`, { status: 'OCCUPIED' })).statusCode).toBe(400);
  });
});

describe('orders', () => {
  async function openCheck(table = 'T-3') {
    expect((await walkIn(table, { partySize: 2 })).statusCode).toBe(201);
    return (await api('GET', `/admin/tables/${ctx.fx.tables[table]}/order`)).json();
  }
  const menuId = async (name: string, venueId = ctx.fx.venueId) =>
    (await getPool().query('SELECT id FROM menu_items WHERE name = $1 AND venue_id = $2', [name, venueId])).rows[0].id as string;

  it('404s when a table has no open order', async () => {
    const res = await api('GET', `/admin/tables/${ctx.fx.tables['T-2']}/order`);
    expect(res.statusCode).toBe(404);
  });

  it('adds menu and custom items, recalculates totals, deletes while PLACED', async () => {
    const o = await openCheck();
    const burrata = await menuId('Burrata');
    let res = await api('POST', `/admin/orders/${o.id}/items`, { menuItemId: burrata, itemName: 'ignored', category: 'WINE', quantity: 2, unitPricePaise: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ itemName: 'Burrata', category: 'STARTER', quantity: 2, unitPricePaise: 65000, lineTotalPaise: 130000 });
    res = await api('POST', `/admin/orders/${o.id}/items`, { itemName: 'Chef special', category: 'ENTREE', quantity: 1, unitPricePaise: 99900, notes: 'no onion' });
    let d = res.json();
    expect(d).toMatchObject({ grossPaise: 229900, discountPaise: 0, netPaise: 229900 });
    expect(d.items).toHaveLength(2);

    const burrataLine = d.items.find((i: any) => i.itemName === 'Burrata');
    res = await api('DELETE', `/admin/orders/${o.id}/items/${burrataLine.id}`);
    d = res.json();
    expect(res.statusCode).toBe(200);
    expect(d.items.map((i: any) => i.itemName)).toEqual(['Chef special']);
    expect(d.netPaise).toBe(99900);

    expect((await api('GET', `/admin/orders/${o.id}`)).json().netPaise).toBe(99900);
  });

  it('progresses PLACED → RECEIVED → PREPARING → SERVED with timestamps; blocks delete after send', async () => {
    const o = await openCheck();
    const d0 = (await api('POST', `/admin/orders/${o.id}/items`, { itemName: 'Soup', category: 'STARTER', quantity: 1, unitPricePaise: 30000 })).json();
    expect((await api('POST', `/admin/orders/${o.id}/status`, { status: 'SERVED' })).json().error.code).toBe('ILLEGAL_TRANSITION');
    clock.advanceMinutes(2);
    const rec = await api('POST', `/admin/orders/${o.id}/status`, { status: 'RECEIVED' });
    expect(rec.json()).toMatchObject({ status: 'RECEIVED', receivedAt: '2026-10-02T12:32:00.000Z' });

    const del = await api('DELETE', `/admin/orders/${o.id}/items/${d0.items[0].id}`);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe('ORDER_ALREADY_SENT');

    clock.advanceMinutes(3);
    expect((await api('POST', `/admin/orders/${o.id}/status`, { status: 'PREPARING' })).json()).toMatchObject({ preparingAt: '2026-10-02T12:35:00.000Z' });
    const served = (await api('POST', `/admin/orders/${o.id}/status`, { status: 'SERVED' })).json();
    expect(served).toMatchObject({ status: 'SERVED', servedAt: '2026-10-02T12:35:00.000Z' });
    // Still open: more items can be added after SERVED.
    expect((await api('POST', `/admin/orders/${o.id}/items`, { itemName: 'Tea', category: 'BEVERAGE', quantity: 1, unitPricePaise: 10000 })).json().netPaise).toBe(40000);

    for (const status of ['BILLED', 'VOIDED', 'PARTIALLY_PAID', 'PLACED']) {
      const r = await api('POST', `/admin/orders/${o.id}/status`, { status });
      expect(r.statusCode).toBe(400);
    }
  });

  it('refuses items on closed orders (ORDER_CLOSED)', async () => {
    const o = await openCheck();
    for (const status of ['BILLED', 'VOIDED', 'PARTIALLY_PAID']) {
      await getPool().query('UPDATE pos_orders SET status = $2 WHERE id = $1', [o.id, status]);
      const r = await api('POST', `/admin/orders/${o.id}/items`, { itemName: 'X', category: 'STARTER', quantity: 1, unitPricePaise: 100 });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('ORDER_CLOSED');
    }
  });

  it('scopes menu items and orders to the venue', async () => {
    const o = await openCheck();
    await getPool().query(`INSERT INTO menu_items (venue_id, name, category, price_paise) VALUES ($1,'Foreign','STARTER',100)`, [ctx.fx.otherVenueId]);
    const foreign = await menuId('Foreign', ctx.fx.otherVenueId);
    const r = await api('POST', `/admin/orders/${o.id}/items`, { menuItemId: foreign, itemName: 'x', category: 'STARTER', quantity: 1, unitPricePaise: 1 });
    expect(r.statusCode).toBe(404);
    const other = await ctx.login('other');
    expect((await api('GET', `/admin/orders/${o.id}`, undefined, other)).statusCode).toBe(403);
    expect((await api('GET', `/admin/tables/${ctx.fx.tables['T-3']}/order`, undefined, other)).statusCode).toBe(403);
    expect((await api('POST', `/admin/orders/${o.id}/status`, { status: 'RECEIVED' }, other)).statusCode).toBe(403);
    expect((await api('GET', `/admin/orders/00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404);
  });
});

describe('dwell monitor', () => {
  const alerts = async (kind?: string) =>
    (await getPool().query(`SELECT * FROM alerts WHERE ($1::text IS NULL OR kind = $1) ORDER BY created_at`, [kind ?? null])).rows;

  it('raises amber then red once each per seating', async () => {
    const w = (await walkIn('T-1')).json();
    clock.advanceMinutes(29);
    await runJob('dwell-monitor');
    expect(await alerts()).toHaveLength(0);

    clock.advanceMinutes(1);
    await runJob('dwell-monitor');
    await runJob('dwell-monitor');
    const amber = await alerts('DWELL_AMBER');
    expect(amber).toHaveLength(1);
    expect(amber[0]).toMatchObject({ severity: 'warning', dedupe_key: `dwell-amber:${w.id}` });
    expect(await alerts('DWELL_RED')).toHaveLength(0);

    clock.advanceMinutes(15);
    await runJob('dwell-monitor');
    await runJob('dwell-monitor');
    const red = await alerts('DWELL_RED');
    expect(red).toHaveLength(1);
    expect(red[0]).toMatchObject({ severity: 'critical', dedupe_key: `dwell-red:${w.id}` });
    expect(await alerts('DWELL_AMBER')).toHaveLength(1);
    // No next booking -> no migration, no SMS.
    expect(await alerts('AUTO_MIGRATED')).toHaveLength(0);
    expect((await getPool().query('SELECT * FROM notifications_outbox')).rows).toHaveLength(0);
  });

  it('auto-migrates the next booking to a free best-fit table at red', async () => {
    expect((await walkIn('T-3', { partySize: 3 })).statusCode).toBe(201);
    const next = await insertReservation({ table: 'T-3', at: '19:00', party: 3, first: 'Diya', last: 'Sharma' });
    const later = await insertReservation({ table: 'T-3', at: '20:00', party: 3 }); // outside 15-min window
    clock.advanceMinutes(45); // 18:45, next booking at 19:00
    await runJob('dwell-monitor');

    const moved = (await getPool().query('SELECT table_id, status FROM reservations WHERE id = $1', [next.id])).rows[0];
    expect(moved).toEqual({ table_id: ctx.fx.tables['T-4'], status: 'CONFIRMED' });
    expect((await getPool().query('SELECT table_id FROM reservations WHERE id = $1', [later.id])).rows[0].table_id).toBe(ctx.fx.tables['T-3']);
    const mig = await alerts('AUTO_MIGRATED');
    expect(mig).toHaveLength(1);
    expect(mig[0]).toMatchObject({ severity: 'info' });
    expect(mig[0].data).toMatchObject({ reservationId: next.id, fromTableNumber: 'T-3', toTableNumber: 'T-4' });
    expect((await getPool().query(`SELECT * FROM audit_logs WHERE action = 'reservation.auto_migrated'`)).rows).toHaveLength(1);
    expect((await getPool().query('SELECT * FROM notifications_outbox')).rows).toHaveLength(0);

    // Floor now shows the booking as T-4's next (and RESERVED since 19:00 − 30 ≤ 18:45).
    const s = await floor();
    expect(byNum(s, 'T-4')).toMatchObject({ floorStatus: 'RESERVED', next: { reservationId: next.id } });

    // Red already raised -> a later run does not migrate again.
    await runJob('dwell-monitor');
    expect(await alerts('AUTO_MIGRATED')).toHaveLength(1);
  });

  it('sends the complimentary-beverage SMS when no table is free', async () => {
    expect((await walkIn('T-3', { partySize: 3 })).statusCode).toBe(201);
    await getPool().query(`UPDATE dining_tables SET status = 'BLOCKED' WHERE id = $1`, [ctx.fx.tables['T-4']]);
    const next = await insertReservation({ table: 'T-3', at: '19:00', party: 3 });
    clock.advanceMinutes(45);
    await runJob('dwell-monitor');
    await runJob('dwell-monitor');

    expect((await getPool().query('SELECT table_id FROM reservations WHERE id = $1', [next.id])).rows[0].table_id).toBe(ctx.fx.tables['T-3']);
    const sms = (await getPool().query('SELECT * FROM notifications_outbox')).rows;
    expect(sms).toHaveLength(1);
    expect(sms[0]).toMatchObject({
      template: 'DWELL_DELAY',
      channel: 'SMS',
      reservation_id: next.id,
      body: 'Your table is undergoing final preparation. Enjoy a complimentary beverage at the bar while we finalize your seating.',
    });
    expect(await alerts('AUTO_MIGRATED')).toHaveLength(0);
  });

  it('skips alternatives whose interval is taken', async () => {
    expect((await walkIn('T-3', { partySize: 3 })).statusCode).toBe(201);
    const next = await insertReservation({ table: 'T-3', at: '19:00', party: 3 });
    await insertReservation({ table: 'T-4', at: '19:15', party: 2 }); // overlaps [19:00,19:30) on T-4
    clock.advanceMinutes(45);
    await runJob('dwell-monitor');
    expect((await getPool().query('SELECT table_id FROM reservations WHERE id = $1', [next.id])).rows[0].table_id).toBe(ctx.fx.tables['T-3']);
    expect((await getPool().query(`SELECT template FROM notifications_outbox`)).rows).toEqual([{ template: 'DWELL_DELAY' }]);
  });
});
