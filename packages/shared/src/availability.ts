/**
 * BR-03 Slot grid, BR-06 Availability and best-fit allocation.
 * Pure function of its inputs: the caller loads tables, combinations and active occupancies
 * for the service date (plus a margin) and passes `now` explicitly.
 */
import { localToInstant, type IsoDate } from './time';
import { resolveTurnMinutes, type Daypart, type TurnRule } from './turn';

export interface ServicePeriod {
  id: string;
  daypart: Daypart;
  /** wall-clock minutes from service-date midnight; 0..1439 */
  openMinute: number;
  /** last bookable start; openMinute..2879 */
  lastSeatingMinute: number;
  /** closeMinute >= lastSeatingMinute; informational for availability */
  closeMinute: number;
}

/** BR-03: slots start at the first multiple of the interval >= openMinute, step interval, up to lastSeatingMinute inclusive. */
export function slotMinutes(period: ServicePeriod, intervalMinutes: number): number[] {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) throw new Error('interval must be a positive integer');
  const out: number[] = [];
  const first = Math.ceil(period.openMinute / intervalMinutes) * intervalMinutes;
  for (let m = first; m <= period.lastSeatingMinute; m += intervalMinutes) out.push(m);
  return out;
}

export interface TableInput {
  id: string;
  label: string;
  minCovers: number;
  maxCovers: number;
  diningAreaId: string;
  /** dining_areas.sort_order of the table's area; lower = preferred (e.g. main room 0, bar 1) */
  areaSortOrder: number;
  active: boolean;
  onlineBookable: boolean;
}

export interface CombinationInput {
  id: string;
  name: string;
  minCovers: number;
  maxCovers: number;
  tableIds: string[];
  active: boolean;
}

/** An active occupancy of one table: [startMs, endMs). endMs already includes the reset buffer. */
export interface Occupancy {
  tableId: string;
  startMs: number;
  endMs: number;
}

export interface PacingBooking {
  startsAtMs: number;
  partySize: number;
}

export interface AvailabilityQuery {
  serviceDate: IsoDate;
  timeZone: string;
  period: ServicePeriod;
  slotIntervalMinutes: number;
  partySize: number;
  /** 'public' = guest-facing channels (only online-bookable tables); 'staff' = console/phone. */
  channel: 'public' | 'staff';
  nowMs: number;
  minLeadMinutes: number;
  resetMinutes: number;
  turnRules: ReadonlyArray<TurnRule>;
  defaultTurnMinutes: number;
  diningAreaId?: string | null;
  tables: ReadonlyArray<TableInput>;
  combinations: ReadonlyArray<CombinationInput>;
  occupancies: ReadonlyArray<Occupancy>;
  /** null/undefined = no pacing limit */
  maxCoversPerSlot?: number | null;
  /** Non-cancelled, non-no-show reservations used for pacing counts. */
  pacingBookings?: ReadonlyArray<PacingBooking>;
  closed: boolean;
}

export interface AllocatedUnit {
  kind: 'table' | 'combination';
  id: string;
  label: string;
  tableIds: string[];
  maxCovers: number;
  turnMinutes: number;
}

export type UnavailableReason = 'closed' | 'lead_time' | 'pacing' | 'no_table';

export interface SlotResult {
  minuteOfDay: number;
  startsAt: string;
  available: boolean;
  reason: UnavailableReason | null;
  turnMinutes: number | null;
  unit: AllocatedUnit | null;
}

interface Candidate {
  unit: AllocatedUnit;
  waste: number;
  isCombination: boolean;
  tableCount: number;
  areaSortOrder: number;
}

function isFree(tableIds: ReadonlyArray<string>, startMs: number, endMs: number, occupancies: ReadonlyArray<Occupancy>): boolean {
  for (const o of occupancies) {
    if (tableIds.includes(o.tableId) && o.startMs < endMs && startMs < o.endMs) return false;
  }
  return true;
}

/**
 * Best-fit allocation for a start instant. Order: least wasted seats, single tables before
 * combinations, fewer tables, preferred dining area (lower areaSortOrder), then label ascending.
 * Returns null when nothing fits.
 */
export function allocateBestFit(q: AvailabilityQuery, startMs: number, excludeUnitIds: ReadonlyArray<string> = []): AllocatedUnit | null {
  const p = q.partySize;
  const byId = new Map(q.tables.map((t) => [t.id, t] as const));
  const eligibleTable = (t: TableInput): boolean =>
    t.active && (q.channel === 'staff' || t.onlineBookable) && (!q.diningAreaId || t.diningAreaId === q.diningAreaId);
  const candidates: Candidate[] = [];

  for (const t of q.tables) {
    if (excludeUnitIds.includes(t.id) || !eligibleTable(t)) continue;
    if (p < t.minCovers || p > t.maxCovers) continue;
    const turn = resolveTurnMinutes(q.turnRules, { partySize: p, daypart: q.period.daypart, diningAreaId: t.diningAreaId }, q.defaultTurnMinutes);
    const endMs = startMs + (turn + q.resetMinutes) * 60_000;
    if (!isFree([t.id], startMs, endMs, q.occupancies)) continue;
    candidates.push({
      unit: { kind: 'table', id: t.id, label: t.label, tableIds: [t.id], maxCovers: t.maxCovers, turnMinutes: turn },
      waste: t.maxCovers - p,
      isCombination: false,
      tableCount: 1,
      areaSortOrder: t.areaSortOrder,
    });
  }

  for (const c of q.combinations) {
    if (excludeUnitIds.includes(c.id) || !c.active || c.tableIds.length < 2) continue;
    if (p < c.minCovers || p > c.maxCovers) continue;
    const members = c.tableIds.map((id) => byId.get(id));
    if (members.some((m) => m === undefined || !eligibleTable(m))) continue;
    const first = members[0]!;
    const turn = resolveTurnMinutes(q.turnRules, { partySize: p, daypart: q.period.daypart, diningAreaId: first.diningAreaId }, q.defaultTurnMinutes);
    const endMs = startMs + (turn + q.resetMinutes) * 60_000;
    if (!isFree(c.tableIds, startMs, endMs, q.occupancies)) continue;
    candidates.push({
      unit: { kind: 'combination', id: c.id, label: c.name, tableIds: [...c.tableIds], maxCovers: c.maxCovers, turnMinutes: turn },
      waste: c.maxCovers - p,
      isCombination: true,
      tableCount: c.tableIds.length,
      areaSortOrder: first.areaSortOrder,
    });
  }

  candidates.sort((a, b) => {
    if (a.waste !== b.waste) return a.waste - b.waste;
    if (a.isCombination !== b.isCombination) return a.isCombination ? 1 : -1;
    if (a.tableCount !== b.tableCount) return a.tableCount - b.tableCount;
    if (a.areaSortOrder !== b.areaSortOrder) return a.areaSortOrder - b.areaSortOrder;
    return a.unit.label < b.unit.label ? -1 : a.unit.label > b.unit.label ? 1 : 0;
  });
  return candidates[0]?.unit ?? null;
}

/** BR-06: evaluates every slot of the period. Reason precedence: closed, lead_time, pacing, no_table. */
export function computeAvailability(q: AvailabilityQuery): SlotResult[] {
  const results: SlotResult[] = [];
  for (const minute of slotMinutes(q.period, q.slotIntervalMinutes)) {
    const startMs = localToInstant(q.serviceDate, minute, q.timeZone).getTime();
    const base = { minuteOfDay: minute, startsAt: new Date(startMs).toISOString() };
    if (q.closed) {
      results.push({ ...base, available: false, reason: 'closed', turnMinutes: null, unit: null });
      continue;
    }
    if (startMs < q.nowMs + q.minLeadMinutes * 60_000) {
      results.push({ ...base, available: false, reason: 'lead_time', turnMinutes: null, unit: null });
      continue;
    }
    if (q.maxCoversPerSlot !== null && q.maxCoversPerSlot !== undefined) {
      const windowEnd = startMs + q.slotIntervalMinutes * 60_000;
      const covers = (q.pacingBookings ?? [])
        .filter((b) => b.startsAtMs >= startMs && b.startsAtMs < windowEnd)
        .reduce((sum, b) => sum + b.partySize, 0);
      if (covers + q.partySize > q.maxCoversPerSlot) {
        results.push({ ...base, available: false, reason: 'pacing', turnMinutes: null, unit: null });
        continue;
      }
    }
    const unit = allocateBestFit(q, startMs);
    if (!unit) {
      results.push({ ...base, available: false, reason: 'no_table', turnMinutes: null, unit: null });
      continue;
    }
    results.push({ ...base, available: true, reason: null, turnMinutes: unit.turnMinutes, unit });
  }
  return results;
}

/** Occupancy range for a reservation: [startsAt, startsAt + turn + reset). */
export function occupancyFor(startMs: number, turnMinutes: number, resetMinutes: number): { startMs: number; endMs: number } {
  return { startMs, endMs: startMs + (turnMinutes + resetMinutes) * 60_000 };
}

/**
 * Up to `limit` alternative available slots closest to `targetMs` (ties: earlier first),
 * limited to +/- windowMinutes. Used for 409 SLOT_UNAVAILABLE responses.
 */
export function nearestAlternatives(slots: ReadonlyArray<SlotResult>, targetMs: number, limit = 3, windowMinutes = 60): SlotResult[] {
  return slots
    .filter((s) => s.available)
    .map((s) => ({ s, d: Math.abs(Date.parse(s.startsAt) - targetMs), t: Date.parse(s.startsAt) }))
    .filter((x) => x.d > 0 && x.d <= windowMinutes * 60_000)
    .sort((a, b) => (a.d !== b.d ? a.d - b.d : a.t - b.t))
    .slice(0, limit)
    .map((x) => x.s);
}
