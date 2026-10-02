/**
 * BR-09 Table floor status, BR-10 timers and alerts, BR-11 waitlist quoting.
 * Stored floor status is only: available | occupied | bussing | blocked.
 * "Upcoming reservation" is a DERIVED badge, never stored.
 */
export type FloorStatus = 'available' | 'occupied' | 'bussing' | 'blocked';
export type FloorAction = 'seat' | 'complete' | 'clear' | 'block' | 'unblock';

const FLOOR_TRANSITIONS: Readonly<Record<FloorStatus, Partial<Record<FloorAction, FloorStatus>>>> = {
  available: { seat: 'occupied', block: 'blocked' },
  occupied: { complete: 'bussing' },
  bussing: { clear: 'available', block: 'blocked', seat: 'occupied' },
  blocked: { unblock: 'available' },
};

export function floorTransition(from: FloorStatus, action: FloorAction): FloorStatus | null {
  return FLOOR_TRANSITIONS[from][action] ?? null;
}

export type AlertLevel = 'normal' | 'amber' | 'red';
export type DwellLevel = AlertLevel;

/** BR-10: amber at 100% of turn, red at ceil(125% of turn). elapsed floored to whole minutes. */
export function timerState(seatedAtMs: number, turnMinutes: number, nowMs: number): { elapsedMinutes: number; level: AlertLevel } {
  const elapsedMinutes = Math.max(0, Math.floor((nowMs - seatedAtMs) / 60_000));
  const redAt = Math.ceil(turnMinutes * 1.25);
  const level: AlertLevel = elapsedMinutes >= redAt ? 'red' : elapsedMinutes >= turnMinutes ? 'amber' : 'normal';
  return { elapsedMinutes, level };
}

export interface UpcomingCandidate {
  reservationId: string;
  startsAtMs: number;
  status: 'confirmed' | 'arrived' | 'late';
}

/** Earliest active reservation on the table whose start is within [now - grace, now + holdWindow]. */
export function upcomingBadge(
  candidates: ReadonlyArray<UpcomingCandidate>,
  nowMs: number,
  holdWindowMinutes: number,
  graceMinutes: number,
): UpcomingCandidate | null {
  const eligible = candidates
    .filter((c) => c.startsAtMs - holdWindowMinutes * 60_000 <= nowMs && nowMs < c.startsAtMs + graceMinutes * 60_000)
    .sort((a, b) => a.startsAtMs - b.startsAtMs);
  return eligible[0] ?? null;
}

/** When a table is expected to become free, for waitlist quoting. */
export function tableFreeAt(status: FloorStatus, nowMs: number, predictedReleaseMs: number | null): number | null {
  switch (status) {
    case 'available':
      return nowMs;
    case 'bussing':
      return nowMs + 5 * 60_000;
    case 'occupied':
      return Math.max(nowMs + 5 * 60_000, predictedReleaseMs ?? nowMs + 5 * 60_000);
    case 'blocked':
      return null;
  }
}

export interface WaitTable {
  id: string;
  label: string;
  minCovers: number;
  maxCovers: number;
  /** from tableFreeAt(); null = unusable */
  freeAtMs: number | null;
  /** start of the next active reservation assigned to this table that is not yet seated, or null */
  nextReservationStartMs: number | null;
}

export interface WaitParty {
  id: string;
  partySize: number;
  turnMinutes: number;
}

export interface WaitQuote {
  partyId: string;
  tableId: string | null;
  seatAtMs: number | null;
  /** rounded UP to 5 minutes; null = cannot quote (host decides) */
  quoteMinutes: number | null;
}

/**
 * BR-11: parties in queue order are greedily placed on the single table that frees earliest
 * and can hold them for turn + reset before its next reservation. Ties: smaller maxCovers, then label.
 */
export function quoteWaitlist(nowMs: number, tables: ReadonlyArray<WaitTable>, parties: ReadonlyArray<WaitParty>, resetMinutes: number): WaitQuote[] {
  const state = tables
    .filter((t) => t.freeAtMs !== null)
    .map((t) => ({ ...t, freeAtMs: t.freeAtMs as number }));
  const quotes: WaitQuote[] = [];
  for (const party of parties) {
    const blockMs = (party.turnMinutes + resetMinutes) * 60_000;
    const feasible = state
      .filter((t) => party.partySize >= t.minCovers && party.partySize <= t.maxCovers)
      .filter((t) => t.nextReservationStartMs === null || t.freeAtMs + blockMs <= t.nextReservationStartMs)
      .sort((a, b) => {
        if (a.freeAtMs !== b.freeAtMs) return a.freeAtMs - b.freeAtMs;
        if (a.maxCovers !== b.maxCovers) return a.maxCovers - b.maxCovers;
        return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
      });
    const chosen = feasible[0];
    if (!chosen) {
      quotes.push({ partyId: party.id, tableId: null, seatAtMs: null, quoteMinutes: null });
      continue;
    }
    const seatAtMs = Math.max(nowMs, chosen.freeAtMs);
    const waitMinutes = (seatAtMs - nowMs) / 60_000;
    quotes.push({ partyId: party.id, tableId: chosen.id, seatAtMs, quoteMinutes: Math.ceil(waitMinutes / 5) * 5 });
    chosen.freeAtMs = seatAtMs + blockMs;
  }
  return quotes;
}
