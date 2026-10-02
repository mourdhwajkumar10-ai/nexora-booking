/**
 * Authoritative Domain Adapter & Reference Oracle Bridge for E2E Tests.
 *
 * This module exports the business domain functions, mathematical models,
 * and state machines specified in PROJECT.md, ORIGINAL_REQUEST.md, and Redline v2.
 * It uses the authoritative reference domain implementation as the ground-truth oracle.
 */

import * as refDomain from '../../../Restaurant-Platform-Implementation-Plan-Pack/restaurant-platform-plan/reference/domain/src/index.js';

export * from '../../../Restaurant-Platform-Implementation-Plan-Pack/restaurant-platform-plan/reference/domain/src/index.js';

export type Currency = 'USD' | 'INR';

/**
 * Adapter implementing applyReservationEvent specified in PROJECT.md
 * wrapping the reference domain applyEvent.
 */
export function applyReservationEvent(
  r: {
    status: refDomain.ReservationStatus;
    startsAtMs: number;
    serviceDate?: any;
    arrivedAtMs?: number | null;
    noShowConfirmedAtMs?: number | null;
    [k: string]: any;
  },
  event: refDomain.ReservationEvent,
  ctx: {
    nowMs: number;
    actor: refDomain.Actor;
    todayServiceDate?: any;
    graceMinutes?: number;
    lateCancelWindowHours?: number;
  }
) {
  const snapshot: refDomain.ReservationSnapshot = {
    status: r.status,
    startsAtMs: r.startsAtMs,
    serviceDate: r.serviceDate ?? '2026-10-02',
    arrivedAtMs: r.arrivedAtMs ?? null,
    noShowConfirmedAtMs: r.noShowConfirmedAtMs ?? null,
  };
  const context: refDomain.TransitionContext = {
    nowMs: ctx.nowMs,
    actor: ctx.actor,
    todayServiceDate: ctx.todayServiceDate ?? snapshot.serviceDate,
    lateCancelWindowHours: ctx.lateCancelWindowHours ?? 2,
  };
  const res = refDomain.applyEvent(snapshot, event, context);
  if (!res.ok) {
    throw new Error(`Transition failed with error: ${res.error}`);
  }
  return {
    status: res.to,
    patch: res.patch,
    effects: res.effects,
  };
}

/**
 * BR-01 & Multi-Market Engine: formatMoney
 * Multi-market currency formatting for USD ($) and INR (₹).
 * - USD amounts represent integer cents (e.g., 2550 -> "$25.50").
 * - INR amounts represent integer paise (e.g., 255000 -> "₹2,550", 255050 -> "₹2,550.50").
 */
export function formatMoney(amount: number, currency: Currency): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (currency === 'USD') {
    const dollars = Math.floor(abs / 100).toLocaleString('en-US');
    return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
  } else {
    const rupees = Math.floor(abs / 100).toLocaleString('en-IN');
    const paise = abs % 100;
    return paise > 0 ? `${sign}₹${rupees}.${String(paise).padStart(2, '0')}` : `${sign}₹${rupees}`;
  }
}

/**
 * Maximum capacity calculation per shift (BR-03 corrected formula):
 * N_max = floor((T_last - T_open) / (T_turn + T_reset)) + 1
 */
export function calculateShiftCapacity(
  openMinute: number,
  lastSeatingMinute: number,
  turnMinutes: number,
  resetMinutes: number = 10
): number {
  if (lastSeatingMinute < openMinute) return 0;
  return Math.floor((lastSeatingMinute - openMinute) / (turnMinutes + resetMinutes)) + 1;
}

/**
 * Best-fit table allocation ordering ladder:
 * 1. Smallest non-negative seat differential: delta = maxCapacity - partySize
 * 2. Single table before multi-table combinations
 * 3. Fewer physical tables (for combinations)
 * 4. Area sort order
 * 5. Lexicographical table label ascending
 */
export interface CandidateTable {
  id: string;
  label: string;
  minCapacity: number;
  maxCapacity: number;
  isCombination?: boolean;
  constituentTableIds?: string[];
  areaSortOrder?: number;
}

export function sortBestFitTables(
  tables: ReadonlyArray<CandidateTable>,
  partySize: number
): CandidateTable[] {
  return [...tables]
    .filter((t) => t.minCapacity <= partySize && partySize <= t.maxCapacity)
    .sort((a, b) => {
      const deltaA = a.maxCapacity - partySize;
      const deltaB = b.maxCapacity - partySize;
      if (deltaA !== deltaB) return deltaA - deltaB;
      const isCombA = a.isCombination ? 1 : 0;
      const isCombB = b.isCombination ? 1 : 0;
      if (isCombA !== isCombB) return isCombA - isCombB;
      const constituentCountA = a.constituentTableIds?.length ?? 1;
      const constituentCountB = b.constituentTableIds?.length ?? 1;
      if (constituentCountA !== constituentCountB) return constituentCountA - constituentCountB;
      const sortA = a.areaSortOrder ?? 0;
      const sortB = b.areaSortOrder ?? 0;
      if (sortA !== sortB) return sortA - sortB;
      return a.label.localeCompare(b.label);
    });
}
