/**
 * Seed data. `seedDemo` builds a realistic multi-venue dataset (3 localities, 9 venues) with live
 * reservations/orders around "now"; `seedTestFixture` builds a tiny deterministic fixture for tests.
 */
import pg from 'pg';
import { utcToZonedParts, addMinutes } from '@nexora/shared';
import { hashPassword } from '../lib/auth';
import { hashGiftCard } from '../lib/crypto';

type Db = pg.Client | pg.PoolClient;

const TZ = 'Asia/Kolkata';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

async function one(db: Db, sql: string, params: unknown[] = []) {
  return (await db.query(sql, params)).rows[0];
}

export interface TestFixture {
  localityId: string;
  venueId: string;
  venueSlug: string;
  tables: Record<string, string>; // table_number -> id
  managerEmail: string;
  hostEmail: string;
  otherVenueHostEmail: string;
  otherVenueId: string;
  password: string;
}

export const TEST_PASSWORD = 'nexora123';

/** Deterministic fixture: venue open 12:00–23:00 daily; 2-tops T-1,T-2 (1–2); 4-tops T-3,T-4 (2–4). */
export async function seedTestFixture(db: Db): Promise<TestFixture> {
  const loc = await one(db, `INSERT INTO localities (slug, name, city) VALUES ('cyber-city','Cyber City','Gurgaon') RETURNING id`);
  const venue = await one(
    db,
    `INSERT INTO venues (slug, name, locality_id, address, cuisines, rating, rating_count, cost_for_one_paise, cost_for_two_paise, timezone)
     VALUES ('test-bistro','Test Bistro',$1,'DLF Phase 2',ARRAY['Italian'],4.5,120,80000,150000,$2) RETURNING id`,
    [loc.id, TZ],
  );
  const other = await one(
    db,
    `INSERT INTO venues (slug, name, locality_id, cost_for_one_paise, cost_for_two_paise) VALUES ('other-place','Other Place',$1,50000,90000) RETURNING id`,
    [loc.id],
  );
  for (const v of [venue.id, other.id])
    for (const d of ALL_DAYS) await db.query(`INSERT INTO operating_shifts (venue_id, day_of_week, open_time, close_time) VALUES ($1,$2,'12:00','23:00')`, [v, d]);
  const tables: Record<string, string> = {};
  for (const [num, min, max] of [['T-1', 1, 2], ['T-2', 1, 2], ['T-3', 2, 4], ['T-4', 2, 4]] as const) {
    const t = await one(db, `INSERT INTO dining_tables (venue_id, table_number, min_capacity, max_capacity) VALUES ($1,$2,$3,$4) RETURNING id`, [venue.id, num, min, max]);
    tables[num] = t.id;
  }
  await db.query(`INSERT INTO dining_tables (venue_id, table_number, min_capacity, max_capacity) VALUES ($1,'O-1',1,4)`, [other.id]);
  await db.query(
    `INSERT INTO menu_items (venue_id, name, category, price_paise) VALUES
     ($1,'Burrata','STARTER',65000),($1,'Truffle Risotto','ENTREE',120000),($1,'Barolo 2018 (btl)','WINE',950000),($1,'Tiramisu','DESSERT',45000)`,
    [venue.id],
  );
  const pw = hashPassword(TEST_PASSWORD);
  await db.query(
    `INSERT INTO staff_users (venue_id, email, name, role, password_hash) VALUES
     (NULL,'manager@test.dev','Test Manager','MANAGER',$1),
     ($2,'host@test.dev','Test Host','HOST',$1),
     ($3,'other@test.dev','Other Host','HOST',$1)`,
    [pw, venue.id, other.id],
  );
  return {
    localityId: loc.id,
    venueId: venue.id,
    venueSlug: 'test-bistro',
    tables,
    managerEmail: 'manager@test.dev',
    hostEmail: 'host@test.dev',
    otherVenueHostEmail: 'other@test.dev',
    otherVenueId: other.id,
    password: TEST_PASSWORD,
  };
}

// ------------------------------------------------------------------ demo data
const LOCALITIES = [
  { slug: 'cyber-city-gurgaon', name: 'Cyber City', city: 'Gurgaon' },
  { slug: 'koramangala-bangalore', name: 'Koramangala', city: 'Bangalore' },
  { slug: 'bkc-mumbai', name: 'Bandra Kurla Complex', city: 'Mumbai' },
];

const img = (id: string) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=70`;

const VENUES = [
  { loc: 0, slug: 'ember-and-oak', name: 'Ember & Oak', cuisines: ['Modern Indian', 'Grill'], rating: 4.6, rc: 2140, one: 1400, two: 2600, img: 'photo-1517248135467-4c7edcad34c4', addr: 'DLF Cyber Hub, Tower B', desc: 'Wood-fired Indian small plates and a serious whisky list.' },
  { loc: 0, slug: 'saffron-lane', name: 'Saffron Lane', cuisines: ['North Indian', 'Mughlai'], rating: 4.3, rc: 980, one: 900, two: 1700, img: 'photo-1555396273-367ea4eb4db5', addr: 'Cyber City, Building 10', desc: 'Slow-cooked dum biryanis and tandoor classics.' },
  { loc: 0, slug: 'the-copper-still', name: 'The Copper Still', cuisines: ['European', 'Bar'], rating: 4.4, rc: 1530, one: 1800, two: 3400, img: 'photo-1514933651103-005eec06c04b', addr: 'Cyber Hub, Ground Floor', desc: 'Late-night cocktail bar and European bistro. Open past midnight.', late: true },
  { loc: 1, slug: 'kinfolk-kitchen', name: 'Kinfolk Kitchen', cuisines: ['Cafe', 'Continental'], rating: 4.5, rc: 3120, one: 700, two: 1300, img: 'photo-1554118811-1e0d58224f24', addr: '80 Feet Rd, 4th Block', desc: 'All-day brunch, sourdough and single-origin coffee.' },
  { loc: 1, slug: 'umami-house', name: 'Umami House', cuisines: ['Japanese', 'Sushi'], rating: 4.7, rc: 1890, one: 1600, two: 3000, img: 'photo-1579871494447-9811cf80d66c', addr: '5th Block, Jyoti Nivas College Rd', desc: 'Omakase counter and robata grill.' },
  { loc: 1, slug: 'coastal-curry-co', name: 'Coastal Curry Co.', cuisines: ['South Indian', 'Seafood'], rating: 4.2, rc: 760, one: 800, two: 1500, img: 'photo-1589302168068-964664d93dc0', addr: '1st Block, Koramangala', desc: 'Mangalorean and Malabar seafood curries.' },
  { loc: 2, slug: 'bombay-social-table', name: 'Bombay Social Table', cuisines: ['Pan-Asian', 'Bar'], rating: 4.4, rc: 2650, one: 1500, two: 2800, img: 'photo-1552566626-52f8b828add9', addr: 'G Block, BKC', desc: 'Dim sum, bao and highballs for the BKC crowd.' },
  { loc: 2, slug: 'olive-and-thyme', name: 'Olive & Thyme', cuisines: ['Mediterranean'], rating: 4.5, rc: 1320, one: 1700, two: 3200, img: 'photo-1414235077428-338989a2e8c0', addr: 'Maker Maxity, BKC', desc: 'Mezze, wood-oven flatbreads and natural wines.' },
  { loc: 2, slug: 'masala-library-bkc', name: 'Masala Atelier', cuisines: ['Progressive Indian'], rating: 4.8, rc: 4010, one: 2500, two: 4800, img: 'photo-1559339352-11d035aa65de', addr: 'First International Financial Centre, BKC', desc: 'Tasting menus reimagining regional Indian cuisine.' },
];

const MENU: [string, string, number][] = [
  ['Tandoori Broccoli', 'STARTER', 425], ['Galouti Kebab', 'STARTER', 595], ['Burrata & Heirloom Tomato', 'STARTER', 695],
  ['Butter Chicken', 'ENTREE', 745], ['Dal Makhani', 'ENTREE', 495], ['Dry-Aged Ribeye', 'PREMIUM', 2950],
  ['Truffle Mushroom Risotto', 'ENTREE', 895], ['Fresh Oysters (6)', 'PREMIUM', 1850], ['Gulab Jamun Cheesecake', 'DESSERT', 395],
  ['Fresh Lime Soda', 'BEVERAGE', 195], ['Cold Brew', 'BEVERAGE', 245], ['Cabernet Sauvignon (glass)', 'WINE', 950],
  ['Barolo 2018 (bottle)', 'WINE', 9500],
];

const GUESTS = [
  { first: 'Aarav', last: 'Mehta', phone: '+919810000001', email: 'aarav.mehta@example.com', tags: ['VIP', 'TOP_SPENDER', 'WINE_CONNOISSEUR'], allergies: 'Severe peanut allergy', pref: 'BOOTH', tier: 'REGULAR', visits: 14, spend: 425000_00, points: 45000 },
  { first: 'Diya', last: 'Sharma', phone: '+919810000002', email: 'diya.sharma@example.com', tags: ['REGULAR'], allergies: null, pref: 'WINDOW', tier: 'MEMBER', visits: 6, spend: 62000_00, points: 8200 },
  { first: 'Kabir', last: 'Singh', phone: '+919810000003', email: null, tags: ['SLOW_PACING'], allergies: 'Gluten intolerance', pref: 'QUIET', tier: 'BASE', visits: 3, spend: 9800_00, points: 1200 },
  { first: 'Ananya', last: 'Iyer', phone: '+919810000004', email: 'ananya.iyer@example.com', tags: ['VIP'], allergies: null, pref: 'ANY', tier: 'FRIENDS_AND_FAMILY', visits: 22, spend: 1150000_00, points: 120000 },
  { first: 'Rohan', last: 'Kapoor', phone: '+919810000005', email: null, tags: ['LATE_CANCELLER'], allergies: null, pref: 'ANY', tier: 'BASE', visits: 1, spend: 2400_00, points: 300 },
  { first: 'Meera', last: 'Nair', phone: '+919810000006', email: 'meera.nair@example.com', tags: [], allergies: 'Shellfish', pref: 'PATIO', tier: 'BASE', visits: 0, spend: 0, points: 0 },
];

function roundUp15(d: Date): Date {
  const ms = 15 * 60_000;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}

export async function seedDemo(db: Db): Promise<void> {
  const locIds: string[] = [];
  for (const [i, l] of LOCALITIES.entries()) {
    locIds.push((await one(db, 'INSERT INTO localities (slug, name, city, sort_order) VALUES ($1,$2,$3,$4) RETURNING id', [l.slug, l.name, l.city, i])).id);
  }

  const venueIds: string[] = [];
  for (const v of VENUES) {
    const row = await one(
      db,
      `INSERT INTO venues (slug, name, locality_id, address, description, cuisines, rating, rating_count, image_url, cost_for_one_paise, cost_for_two_paise, timezone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [v.slug, v.name, locIds[v.loc], v.addr, v.desc, v.cuisines, v.rating, v.rc, img(v.img), v.one * 100, v.two * 100, TZ],
    );
    venueIds.push(row.id);
    for (const d of ALL_DAYS) {
      if (v.late) {
        await db.query(`INSERT INTO operating_shifts (venue_id, day_of_week, open_time, close_time) VALUES ($1,$2,'18:00','01:00')`, [row.id, d]);
      } else {
        await db.query(`INSERT INTO operating_shifts (venue_id, day_of_week, open_time, close_time) VALUES ($1,$2,'09:00','16:00'),($1,$2,'18:00','23:30')`, [row.id, d]);
      }
    }
    const layout: [string, string, number, number][] = [
      ['T-1', 'MAIN', 1, 2], ['T-2', 'MAIN', 1, 2], ['T-3', 'WINDOW', 1, 2], ['T-4', 'MAIN', 1, 2],
      ['T-5', 'MAIN', 2, 4], ['T-6', 'MAIN', 2, 4], ['T-7', 'PATIO', 2, 4], ['T-8', 'PATIO', 2, 4],
      ['B-1', 'BAR', 1, 2], ['P-1', 'PRIVATE', 2, 4],
    ];
    for (const [num, zone, min, max] of layout) {
      await db.query(`INSERT INTO dining_tables (venue_id, table_number, dining_zone, min_capacity, max_capacity) VALUES ($1,$2,$3,$4,$5)`, [
        row.id, num, zone === 'WINDOW' ? 'MAIN' : zone, min, max,
      ]);
    }
    for (const [i, [name, cat, price]] of MENU.entries()) {
      await db.query('INSERT INTO menu_items (venue_id, name, category, price_paise, sort_order) VALUES ($1,$2,$3,$4,$5)', [row.id, name, cat, price * 100, i]);
    }
  }

  const pw = hashPassword('nexora123');
  const pwManager = hashPassword('manager123');
  const pwHost = hashPassword('host123');
  const pwAdmin = hashPassword('admin123');
  await db.query(
    `INSERT INTO staff_users (venue_id, email, name, role, password_hash) VALUES
     (NULL,'manager@nexora.dev','Priya Menon','MANAGER',$1),
     ($2,'host@nexora.dev','Arjun Rao','HOST',$1),
     (NULL,'admin@nexora.internal','Org Admin','MANAGER',$3),
     ($2,'manager@themill.com','Venue Manager','MANAGER',$4),
     ($2,'host@themill.com','Lead Host','HOST',$5)`,
    [pw, venueIds[0], pwAdmin, pwManager, pwHost],
  );

  const guestIds: string[] = [];
  for (const g of GUESTS) {
    const row = await one(db, 'INSERT INTO guests (first_name, last_name, phone_number, email) VALUES ($1,$2,$3,$4) RETURNING id', [g.first, g.last, g.phone, g.email]);
    guestIds.push(row.id);
    await db.query(
      `INSERT INTO guest_profiles (guest_id, lifetime_spend_paise, total_visits, avg_party_size, seating_preference, allergies, last_visit_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $3 > 0 THEN now() - interval '9 days' END)`,
      [row.id, g.spend, g.visits, g.visits ? 2.6 : 1, g.pref, g.allergies],
    );
    for (const t of g.tags) await db.query('INSERT INTO guest_tags (guest_id, tag_name, is_auto_generated) VALUES ($1,$2,$3)', [row.id, t, t !== 'VIP']);
    const acct = await one(db, 'INSERT INTO loyalty_accounts (guest_id, tier_level, points_balance, annual_spend_paise) VALUES ($1,$2,$3,$4) RETURNING id', [row.id, g.tier, g.points, g.spend]);
    if (g.points) await db.query(`INSERT INTO loyalty_ledger (account_id, event_type, state, points_delta, note) VALUES ($1,'ACCRUAL','SETTLED',$2,'Opening balance')`, [acct.id, g.points]);
  }

  // Live service at the first venue: reservations around "now" so the floor console has life.
  const v0 = venueIds[0];
  const tables = (await db.query('SELECT id, table_number FROM dining_tables WHERE venue_id = $1', [v0])).rows as { id: string; table_number: string }[];
  const T = (n: string) => tables.find((t) => t.table_number === n)!.id;
  const now = new Date();
  const base = roundUp15(now);
  const localDate = (d: Date) => utcToZonedParts(d, TZ).date;

  async function reservation(guestIdx: number, table: string | null, start: Date, party: number, status: string, source = 'ONLINE', extra: Record<string, unknown> = {}) {
    const end = addMinutes(start, 30);
    return one(
      db,
      `INSERT INTO reservations (venue_id, table_id, guest_id, party_size, booking_date, start_at, end_at, source, status, confirmed_at, seated_at, dietary_requests, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [v0, table ? T(table) : null, guestIds[guestIdx], party, localDate(start), start, end, source, status,
       ['CONFIRMED', 'SEATED'].includes(status) ? addMinutes(now, -20) : null,
       status === 'SEATED' ? (extra.seatedAt as Date) : null,
       (extra.dietary as string) ?? null,
       (extra.createdAt as Date) ?? now],
    );
  }

  // Seated 38 minutes ago on T-5 (amber), with an order in PREPARING.
  const seatedA = addMinutes(now, -38);
  const rA = await reservation(0, 'T-5', new Date(Math.floor(seatedA.getTime() / 900_000) * 900_000), 3, 'SEATED', 'ONLINE', { seatedAt: seatedA });
  await db.query("UPDATE dining_tables SET status = 'OCCUPIED', status_changed_at = $2 WHERE id = $1", [T('T-5'), seatedA]);
  const oA = await one(db, `INSERT INTO pos_orders (venue_id, table_id, reservation_id, guest_id, status, placed_at, received_at, preparing_at) VALUES ($1,$2,$3,$4,'PREPARING',$5,$6,$7) RETURNING id`, [v0, T('T-5'), rA.id, guestIds[0], addMinutes(seatedA, 3), addMinutes(seatedA, 4), addMinutes(seatedA, 6)]);
  await db.query(`INSERT INTO pos_order_items (order_id, item_name, category, quantity, unit_price_paise, notes) VALUES ($1,'Dry-Aged Ribeye','PREMIUM',2,295000,'Medium rare'),($1,'Barolo 2018 (bottle)','WINE',1,950000,NULL),($1,'Tandoori Broccoli','STARTER',1,42500,'No peanuts — allergy')`, [oA.id]);
  await db.query(`UPDATE pos_orders SET gross_paise = 1582500, net_paise = 1582500 WHERE id = $1`, [oA.id]);

  // Walk-in seated 12 minutes ago on T-2 with an order just placed.
  const seatedB = addMinutes(now, -12);
  const rB = await reservation(2, 'T-2', new Date(Math.floor(seatedB.getTime() / 900_000) * 900_000), 2, 'SEATED', 'WALK_IN', { seatedAt: seatedB });
  await db.query("UPDATE dining_tables SET status = 'OCCUPIED', status_changed_at = $2 WHERE id = $1", [T('T-2'), seatedB]);
  const oB = await one(db, `INSERT INTO pos_orders (venue_id, table_id, reservation_id, guest_id, status, placed_at) VALUES ($1,$2,$3,$4,'PLACED',$5) RETURNING id`, [v0, T('T-2'), rB.id, guestIds[2], addMinutes(seatedB, 2)]);
  await db.query(`INSERT INTO pos_order_items (order_id, item_name, category, quantity, unit_price_paise) VALUES ($1,'Dal Makhani','ENTREE',1,49500),($1,'Fresh Lime Soda','BEVERAGE',2,19500)`, [oB.id]);
  await db.query(`UPDATE pos_orders SET gross_paise = 88500, net_paise = 88500 WHERE id = $1`, [oB.id]);

  // Confirmed upcoming bookings (tile shows RESERVED when within the next window).
  await reservation(3, 'T-6', addMinutes(base, 15), 4, 'CONFIRMED', 'ONLINE', { dietary: 'Celebrating an anniversary' });
  await reservation(1, 'T-3', addMinutes(base, 60), 2, 'CONFIRMED', 'PHONE');
  // Requested (triage queue).
  await reservation(5, 'T-1', addMinutes(base, 45), 2, 'REQUESTED', 'ONLINE', { dietary: 'Shellfish allergy', createdAt: addMinutes(now, -2) });
  await reservation(4, 'T-7', addMinutes(base, 90), 4, 'REQUESTED', 'ONLINE');
  // Blocked + bussing tiles for variety.
  await db.query("UPDATE dining_tables SET status = 'BLOCKED' WHERE id = $1", [T('P-1')]);
  await db.query("UPDATE dining_tables SET status = 'BUSSING', status_changed_at = $2 WHERE id = $1", [T('T-8'), addMinutes(now, -3)]);

  // A gift card for split-tender demos: number 6011000000001234
  await db.query(
    `INSERT INTO gift_cards (card_number_hash, last4, current_balance_paise, purchased_by) VALUES ($1,'1234',500000,$2)`,
    [hashGiftCard('6011000000001234'), guestIds[1]],
  );
}
