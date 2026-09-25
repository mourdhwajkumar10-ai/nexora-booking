/**
 * Shared internals for the A4 modules (guests, wifi, pos, loyalty): loyalty accounts, ledger,
 * tiers, auto-tags and the guest profile DTO. Other modules must not import this; they talk to
 * A4 through bus events.
 */
import {
  TIER_LEVELS,
  computeTier,
  tierRule,
  type GuestProfileDto,
  type LedgerEntryDto,
  type LedgerEvent,
  type LedgerState,
  type TierLevel,
} from '@nexora/shared';
import { getPool, query, queryOne, type Queryable, type Tx } from '../../db/pool';
import { clock } from '../../lib/clock';
import { notFound } from '../../lib/errors';
import { iso } from '../../lib/http';

export const DEFICIT_FLAG = 'UNRESOLVED_LOYALTY_DEFICIT';

export interface LoyaltyAccountRow {
  id: string;
  guest_id: string;
  tier_level: TierLevel;
  points_balance: number;
  wallet_balance_paise: number;
  annual_spend_paise: number;
  largest_preload_paise: number;
  created_at: Date;
}

export const tierRank = (t: TierLevel): number => TIER_LEVELS.indexOf(t);

/** Make sure the guest has a profile + loyalty account (seeded or legacy guests may lack them). */
export async function ensureGuestRows(db: Queryable | Tx, guestId: string): Promise<void> {
  const q = 'client' in db ? (s: string, p: unknown[]) => db.query(s, p) : (s: string, p: unknown[]) => query(s, p, db);
  await q('INSERT INTO guest_profiles (guest_id) VALUES ($1) ON CONFLICT DO NOTHING', [guestId]);
  await q('INSERT INTO loyalty_accounts (guest_id) VALUES ($1) ON CONFLICT DO NOTHING', [guestId]);
}

/** Lock (FOR UPDATE) the guest's loyalty account, creating it if missing. */
export async function lockAccount(tx: Tx, guestId: string): Promise<LoyaltyAccountRow> {
  await ensureGuestRows(tx, guestId);
  const a = await tx.one<LoyaltyAccountRow>('SELECT * FROM loyalty_accounts WHERE guest_id = $1 FOR UPDATE', [guestId]);
  if (!a) throw notFound('Loyalty account');
  return a;
}

export async function insertLedger(
  tx: Tx,
  e: {
    accountId: string;
    eventType: LedgerEvent;
    state?: LedgerState;
    pointsDelta?: number;
    amountPaise?: number;
    referenceType?: string | null;
    referenceId?: string | null;
    note?: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO loyalty_ledger (account_id, event_type, state, points_delta, amount_paise, reference_type, reference_id, note, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      e.accountId,
      e.eventType,
      e.state ?? 'SETTLED',
      e.pointsDelta ?? 0,
      e.amountPaise ?? 0,
      e.referenceType ?? null,
      e.referenceId ?? null,
      e.note ?? null,
      clock.now(),
    ],
  );
}

/** Insert an auto-generated tag (idempotent; never overrides a staff tag). */
export async function addAutoTag(tx: Tx, guestId: string, tagName: string): Promise<void> {
  await tx.query(
    `INSERT INTO guest_tags (guest_id, tag_name, is_auto_generated, created_at) VALUES ($1,$2,true,$3)
     ON CONFLICT (guest_id, tag_name) DO NOTHING`,
    [guestId, tagName, clock.now()],
  );
}

/**
 * Persist a (never-downgrading) tier recomputation and apply tier-driven auto-tags (VIP at
 * REGULAR and above). Returns the resulting tier.
 */
export async function applyTier(tx: Tx, account: LoyaltyAccountRow, annualSpendPaise: number, largestPreloadPaise: number): Promise<TierLevel> {
  const next = computeTier(account.tier_level, annualSpendPaise, largestPreloadPaise);
  if (next !== account.tier_level) {
    await tx.query('UPDATE loyalty_accounts SET tier_level = $2 WHERE id = $1', [account.id, next]);
  }
  if (tierRank(next) >= tierRank('REGULAR')) await addAutoTag(tx, account.guest_id, 'VIP');
  return next;
}

export async function addFlag(tx: Tx, guestId: string, flag: string): Promise<void> {
  await tx.query(
    `UPDATE guest_profiles SET flags = array_append(flags, $2) WHERE guest_id = $1 AND NOT ($2 = ANY(flags))`,
    [guestId, flag],
  );
}

export async function removeFlag(tx: Tx, guestId: string, flag: string): Promise<void> {
  await tx.query('UPDATE guest_profiles SET flags = array_remove(flags, $2) WHERE guest_id = $1', [guestId, flag]);
}

export function toLedgerDto(r: any): LedgerEntryDto {
  return {
    id: r.id,
    eventType: r.event_type,
    state: r.state,
    pointsDelta: r.points_delta,
    amountPaise: r.amount_paise,
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    note: r.note,
    createdAt: iso(r.created_at)!,
  };
}

export async function loadLedger(guestId: string, db: Queryable = getPool()): Promise<LedgerEntryDto[]> {
  const rows = await query(
    `SELECT l.* FROM loyalty_ledger l JOIN loyalty_accounts a ON a.id = l.account_id
     WHERE a.guest_id = $1 ORDER BY l.created_at DESC, l.id LIMIT 200`,
    [guestId],
    db,
  );
  return rows.map(toLedgerDto);
}

export const SEATING_LABELS: Record<string, string> = {
  ANY: 'No preference',
  BOOTH: 'Booth',
  WINDOW: 'Window Seat',
  QUIET: 'Quiet Corner',
  PATIO: 'Patio',
};

/** Full CRM profile (GuestProfileDto). Cross-venue by design. */
export async function loadGuestProfile(guestId: string, db: Queryable = getPool()): Promise<GuestProfileDto> {
  const g = await queryOne('SELECT * FROM guests WHERE id = $1', [guestId], db);
  if (!g) throw notFound('Guest');
  await ensureGuestRows(db, guestId);
  const p = (await queryOne('SELECT * FROM guest_profiles WHERE guest_id = $1', [guestId], db))!;
  const a = (await queryOne<LoyaltyAccountRow>('SELECT * FROM loyalty_accounts WHERE guest_id = $1', [guestId], db))!;
  const tags = await query('SELECT * FROM guest_tags WHERE guest_id = $1 ORDER BY created_at, tag_name', [guestId], db);
  const devices = await query('SELECT * FROM guest_devices WHERE guest_id = $1 ORDER BY last_seen_at DESC', [guestId], db);
  const affinities = await query(
    `SELECT i.item_name, SUM(i.quantity)::int AS quantity
     FROM pos_order_items i JOIN pos_orders o ON o.id = i.order_id
     WHERE o.guest_id = $1 AND o.status = 'BILLED' AND NOT i.is_voided
     GROUP BY i.item_name ORDER BY quantity DESC, i.item_name LIMIT 5`,
    [guestId],
    db,
  );
  const reservations = await query(
    `SELECT r.id, r.start_at, r.party_size, r.status, v.name AS venue_name
     FROM reservations r JOIN venues v ON v.id = r.venue_id
     WHERE r.guest_id = $1 ORDER BY r.start_at DESC LIMIT 20`,
    [guestId],
    db,
  );
  return {
    id: g.id,
    name: `${g.first_name} ${g.last_name}`.trim(),
    phone: g.phone_number,
    email: g.email,
    tags: tags.map((t) => t.tag_name),
    tier: a.tier_level,
    totalVisits: p.total_visits,
    lifetimeSpendPaise: p.lifetime_spend_paise,
    lastVisitAt: iso(p.last_visit_at),
    hasAllergies: !!p.allergies?.trim(),
    firstName: g.first_name,
    lastName: g.last_name,
    avgPartySize: p.avg_party_size,
    noShowCount: p.no_show_count,
    totalVoidsCount: p.total_voids_count,
    totalVoidsValuePaise: p.total_voids_value_paise,
    seatingPreference: p.seating_preference,
    dietaryNotes: p.dietary_notes,
    allergies: p.allergies,
    flags: p.flags ?? [],
    tagDetails: tags.map((t) => ({ tagName: t.tag_name, isAutoGenerated: t.is_auto_generated, createdAt: iso(t.created_at)! })),
    devices: devices.map((d) => ({ mac: d.device_mac, firstSeenAt: iso(d.first_seen_at)!, lastSeenAt: iso(d.last_seen_at)! })),
    itemAffinities: affinities.map((r) => ({ itemName: r.item_name, quantity: r.quantity })),
    loyalty: {
      accountId: a.id,
      tier: a.tier_level,
      pointsBalance: a.points_balance,
      walletBalancePaise: a.wallet_balance_paise,
      annualSpendPaise: a.annual_spend_paise,
      multiplier: tierRule(a.tier_level).multiplier,
    },
    reservations: reservations.map((r) => ({
      id: r.id,
      venueName: r.venue_name,
      startAt: iso(r.start_at)!,
      partySize: r.party_size,
      status: r.status,
    })),
    createdAt: iso(g.created_at)!,
  };
}
