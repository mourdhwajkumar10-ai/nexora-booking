/**
 * End-to-End Client & Platform Simulator for Nexora.
 *
 * Implements an integrated stateful model of Guest Web Tracking,
 * Host Floor Console, and POS Manager Terminal based on the requirements
 * in ORIGINAL_REQUEST.md, PROJECT.md, and Redline v2.
 */

import {
  applyReservationEvent,
  timerState,
  classifyAdjustment,
  eligibleSpendCents,
  resolveTurnMinutes,
  DEFAULT_TURN_RULES,
  formatMoney,
  type ReservationStatus,
  type ReservationEvent,
  type FloorStatus,
  type AttributionClass,
  type AdjustmentKind,
  type Currency,
  type AlertLevel,
} from './oracle';

export interface VenueConfig {
  id: string;
  name: string;
  currency: Currency;
  locale: 'en-US' | 'en-IN';
  timezone: string;
  defaultTurnMinutes: number;
}

export interface FloorTable {
  id: string;
  label: string;
  minCapacity: number;
  maxCapacity: number;
  status: FloorStatus;
  isCombination?: boolean;
  constituentIds?: string[];
  currentReservationId?: string;
  seatedAtMs?: number;
  predictedTurnMinutes?: number;
}

export interface SimulatedReservation {
  id: string;
  publicToken: string;
  venueId: string;
  guestId: string;
  guestName: string;
  guestPhone: string;
  partySize: number;
  serviceDate: string;
  startsAtMs: number;
  endsAtMs: number;
  turnMinutes: number;
  status: ReservationStatus;
  tableId?: string;
  history: Array<{ status: ReservationStatus; timestampMs: number; reason?: string }>;
  allergies?: string[];
  specialRequests?: string;
}

export interface POSCheckItem {
  id: string;
  name: string;
  grossCents: number;
  voided: boolean;
  category: string;
  firedAtMs: number | null;
}

export interface POSCheckAdjustment {
  kind: AdjustmentKind;
  itemId: string | null;
  amountCents: number;
  reasonRef: string;
  attributionClass: AttributionClass;
  occurredAtMs: number;
  firedBefore: boolean | null;
  countsAsGuestReturn: boolean;
}

export interface POSCheck {
  id: string;
  reservationId: string;
  tableId: string;
  venueId: string;
  guestId: string;
  items: POSCheckItem[];
  adjustments: POSCheckAdjustment[];
  status: 'OPEN' | 'SETTLED' | 'VOIDED';
  openedAtMs: number;
  settledAtMs?: number;
}

export interface GuestProfile {
  guestId: string;
  name: string;
  phone: string;
  totalVisits: number;
  lifetimeSpend: number;
  loyaltyPoints: number;
  guestReturnsCount: number; // Only incremented by countsAsGuestReturn === true
  guestReturnsValue: number;
  nonGuestVoidsCount: number; // Kitchen/server voids isolated here
  noShowCount: number;
}

export class NexoraPlatformSimulator {
  public venues: Map<string, VenueConfig> = new Map();
  public tables: Map<string, FloorTable> = new Map();
  public reservations: Map<string, SimulatedReservation> = new Map();
  public checks: Map<string, POSCheck> = new Map();
  public profiles: Map<string, GuestProfile> = new Map();
  public currentTimeMs: number = Date.now();

  constructor() {
    this.initDefaultVenuesAndTables();
  }

  public setClock(timeMs: number): void {
    this.currentTimeMs = timeMs;
  }

  public advanceClock(minutes: number): void {
    this.currentTimeMs += minutes * 60_000;
  }

  public advanceClockSeconds(seconds: number): void {
    this.currentTimeMs += seconds * 1_000;
  }

  private initDefaultVenuesAndTables(): void {
    // US Venue: Nexora Manhattan
    const usVenue: VenueConfig = {
      id: 'venue-us-001',
      name: 'Nexora Manhattan',
      currency: 'USD',
      locale: 'en-US',
      timezone: 'America/New_York',
      defaultTurnMinutes: 90,
    };
    this.venues.set(usVenue.id, usVenue);

    // India Venue: Nexora Bengaluru
    const inVenue: VenueConfig = {
      id: 'venue-in-001',
      name: 'Nexora Bengaluru',
      currency: 'INR',
      locale: 'en-IN',
      timezone: 'Asia/Kolkata',
      defaultTurnMinutes: 90,
    };
    this.venues.set(inVenue.id, inVenue);

    // Default tables for US Venue
    this.addTable({ id: 't-us-1', label: 'T1', minCapacity: 1, maxCapacity: 2, status: 'available' });
    this.addTable({ id: 't-us-2', label: 'T2', minCapacity: 3, maxCapacity: 4, status: 'available' });
    this.addTable({ id: 't-us-3', label: 'T3', minCapacity: 3, maxCapacity: 4, status: 'available' });
    this.addTable({ id: 't-us-combo-23', label: 'Combo-23', minCapacity: 5, maxCapacity: 8, status: 'available', isCombination: true, constituentIds: ['t-us-2', 't-us-3'] });

    // Default tables for India Venue
    this.addTable({ id: 't-in-1', label: 'T101', minCapacity: 1, maxCapacity: 2, status: 'available' });
    this.addTable({ id: 't-in-2', label: 'T102', minCapacity: 3, maxCapacity: 4, status: 'available' });
  }

  public addTable(table: FloorTable): void {
    this.tables.set(table.id, table);
  }

  public getOrCreateGuestProfile(guestId: string, name = 'Guest', phone = '+15550001'): GuestProfile {
    let profile = this.profiles.get(guestId);
    if (!profile) {
      profile = {
        guestId,
        name,
        phone,
        totalVisits: 0,
        lifetimeSpend: 0,
        loyaltyPoints: 0,
        guestReturnsCount: 0,
        guestReturnsValue: 0,
        nonGuestVoidsCount: 0,
        noShowCount: 0,
      };
      this.profiles.set(guestId, profile);
    }
    return profile;
  }

  // --- Guest Booking Journey ---

  public createReservation(params: {
    venueId: string;
    guestId: string;
    guestName: string;
    guestPhone: string;
    partySize: number;
    serviceDate: string;
    startsAtMs: number;
    allergies?: string[];
    specialRequests?: string;
  }): SimulatedReservation {
    const venue = this.venues.get(params.venueId);
    if (!venue) throw new Error(`Unknown venue ${params.venueId}`);

    const turnMinutes = resolveTurnMinutes(
      DEFAULT_TURN_RULES.map((r, i) => ({ ...r, id: `r-${i}` })),
      { partySize: params.partySize, daypart: 'dinner' },
      venue.defaultTurnMinutes
    );

    const endsAtMs = params.startsAtMs + turnMinutes * 60_000;
    const resId = `res-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const publicToken = `tok-${resId}`;

    const reservation: SimulatedReservation = {
      id: resId,
      publicToken,
      venueId: params.venueId,
      guestId: params.guestId,
      guestName: params.guestName,
      guestPhone: params.guestPhone,
      partySize: params.partySize,
      serviceDate: params.serviceDate,
      startsAtMs: params.startsAtMs,
      endsAtMs,
      turnMinutes,
      status: 'confirmed',
      history: [{ status: 'confirmed', timestampMs: this.currentTimeMs }],
      allergies: params.allergies,
      specialRequests: params.specialRequests,
    };

    this.reservations.set(resId, reservation);
    this.getOrCreateGuestProfile(params.guestId, params.guestName, params.guestPhone);
    return reservation;
  }

  public getGuestTracking(token: string): SimulatedReservation {
    for (const res of this.reservations.values()) {
      if (res.publicToken === token) return res;
    }
    throw new Error(`Reservation not found for token ${token}`);
  }

  public transitionReservation(
    reservationId: string,
    event: ReservationEvent,
    actor: 'guest' | 'staff' | 'system' = 'staff'
  ): SimulatedReservation {
    const res = this.reservations.get(reservationId);
    if (!res) throw new Error(`Reservation ${reservationId} not found`);

    const result = applyReservationEvent(
      {
        id: res.id,
        venueId: res.venueId,
        serviceDate: res.serviceDate as any,
        startsAtMs: res.startsAtMs,
        partySize: res.partySize,
        status: res.status,
      },
      event,
      { nowMs: this.currentTimeMs, actor, graceMinutes: 15 }
    );

    res.status = result.status;
    res.history.push({ status: result.status, timestampMs: this.currentTimeMs });

    if (result.status === 'no_show') {
      const profile = this.getOrCreateGuestProfile(res.guestId);
      profile.noShowCount += 1;
    }

    return res;
  }

  // --- Host Floor Management Journey ---

  public seatReservation(reservationId: string, tableId: string): void {
    const res = this.reservations.get(reservationId);
    if (!res) throw new Error(`Reservation ${reservationId} not found`);
    const table = this.tables.get(tableId);
    if (!table) throw new Error(`Table ${tableId} not found`);

    if (res.status === 'confirmed' || res.status === 'arrived' || res.status === 'late') {
      this.transitionReservation(reservationId, 'seat', 'staff');
    }

    res.tableId = tableId;
    table.status = 'occupied';
    table.currentReservationId = reservationId;
    table.seatedAtMs = this.currentTimeMs;
    table.predictedTurnMinutes = res.turnMinutes;

    if (table.isCombination && table.constituentIds) {
      for (const cid of table.constituentIds) {
        const constituent = this.tables.get(cid);
        if (constituent) {
          constituent.status = 'occupied';
          constituent.currentReservationId = reservationId;
          constituent.seatedAtMs = this.currentTimeMs;
          constituent.predictedTurnMinutes = res.turnMinutes;
        }
      }
    }
  }

  public getTableDwellState(tableId: string): { elapsedMinutes: number; level: AlertLevel } {
    const table = this.tables.get(tableId);
    if (!table || table.status !== 'occupied' || !table.seatedAtMs || !table.predictedTurnMinutes) {
      return { elapsedMinutes: 0, level: 'normal' };
    }
    return timerState(table.seatedAtMs, table.predictedTurnMinutes, this.currentTimeMs);
  }

  public completeDining(tableId: string): void {
    const table = this.tables.get(tableId);
    if (!table) throw new Error(`Table ${tableId} not found`);

    if (table.currentReservationId) {
      const res = this.reservations.get(table.currentReservationId);
      if (res && res.status === 'seated') {
        this.transitionReservation(res.id, 'complete', 'staff');
        const profile = this.getOrCreateGuestProfile(res.guestId);
        profile.totalVisits += 1;
      }
    }

    table.status = 'bussing';
    table.currentReservationId = undefined;
    table.seatedAtMs = undefined;
    table.predictedTurnMinutes = undefined;

    if (table.isCombination && table.constituentIds) {
      for (const cid of table.constituentIds) {
        const constituent = this.tables.get(cid);
        if (constituent) {
          constituent.status = 'bussing';
          constituent.currentReservationId = undefined;
          constituent.seatedAtMs = undefined;
          constituent.predictedTurnMinutes = undefined;
        }
      }
    }
  }

  public clearTableBussing(tableId: string): void {
    const table = this.tables.get(tableId);
    if (!table) throw new Error(`Table ${tableId} not found`);
    table.status = 'available';

    if (table.isCombination && table.constituentIds) {
      for (const cid of table.constituentIds) {
        const constituent = this.tables.get(cid);
        if (constituent) constituent.status = 'available';
      }
    }
  }

  // --- POS Order & Fair Void Management Journey ---

  public createPOSCheck(reservationId: string, tableId: string): POSCheck {
    const res = this.reservations.get(reservationId);
    if (!res) throw new Error(`Reservation ${reservationId} not found`);

    const checkId = `chk-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const check: POSCheck = {
      id: checkId,
      reservationId,
      tableId,
      venueId: res.venueId,
      guestId: res.guestId,
      items: [],
      adjustments: [],
      status: 'OPEN',
      openedAtMs: this.currentTimeMs,
    };
    this.checks.set(checkId, check);
    return check;
  }

  public addCheckItem(checkId: string, item: { id: string; name: string; grossCents: number; category: string; firedAtMs?: number | null }): POSCheckItem {
    const check = this.checks.get(checkId);
    if (!check) throw new Error(`Check ${checkId} not found`);
    const checkItem: POSCheckItem = {
      id: item.id,
      name: item.name,
      grossCents: item.grossCents,
      voided: false,
      category: item.category,
      firedAtMs: item.firedAtMs ?? null,
    };
    check.items.push(checkItem);
    return checkItem;
  }

  public voidCheckItem(
    checkId: string,
    itemId: string,
    params: {
      kind: AdjustmentKind;
      reasonRef: string;
      mappings: Record<string, AttributionClass>;
      fireDataAvailable?: boolean;
    }
  ): POSCheckAdjustment {
    const check = this.checks.get(checkId);
    if (!check) throw new Error(`Check ${checkId} not found`);
    const item = check.items.find((i) => i.id === itemId);
    if (!item) throw new Error(`Item ${itemId} not found on check`);

    item.voided = true;

    const classification = classifyAdjustment({
      kind: params.kind,
      reasonRef: params.reasonRef,
      mappings: params.mappings,
      firedAtMs: item.firedAtMs,
      occurredAtMs: this.currentTimeMs,
      fireDataAvailable: params.fireDataAvailable ?? true,
    });

    const adjustment: POSCheckAdjustment = {
      kind: params.kind,
      itemId,
      amountCents: item.grossCents,
      reasonRef: params.reasonRef,
      attributionClass: classification.attributionClass,
      occurredAtMs: this.currentTimeMs,
      firedBefore: classification.firedBefore,
      countsAsGuestReturn: classification.countsAsGuestReturn,
    };

    check.adjustments.push(adjustment);

    // Profile impact: ONLY countsAsGuestReturn increments return metrics
    const profile = this.getOrCreateGuestProfile(check.guestId);
    if (classification.countsAsGuestReturn) {
      profile.guestReturnsCount += 1;
      profile.guestReturnsValue += item.grossCents;
    } else {
      profile.nonGuestVoidsCount += 1;
    }

    return adjustment;
  }

  public settleCheck(checkId: string): { eligibleSpend: number; pointsEarned: number } {
    const check = this.checks.get(checkId);
    if (!check) throw new Error(`Check ${checkId} not found`);
    check.status = 'SETTLED';
    check.settledAtMs = this.currentTimeMs;

    const venue = this.venues.get(check.venueId);
    const eligibleSpend = eligibleSpendCents(
      check.items.map((i) => ({ id: i.id, grossCents: i.grossCents, voided: i.voided, category: i.category })),
      check.adjustments.map((a) => ({ kind: a.kind, itemId: a.itemId, amountCents: a.amountCents }))
    );

    // Points calculation: US $1 = 1 pt (100 cents); India ₹10 = 1 pt (1000 paise)
    const pointsRate = venue?.currency === 'INR' ? 1000 : 100;
    const pointsEarned = Math.floor(eligibleSpend / pointsRate);

    const profile = this.getOrCreateGuestProfile(check.guestId);
    profile.lifetimeSpend += eligibleSpend;
    profile.loyaltyPoints += pointsEarned;

    return { eligibleSpend, pointsEarned };
  }

  public formatVenueCurrency(amount: number, venueId: string): string {
    const venue = this.venues.get(venueId);
    if (!venue) throw new Error(`Venue ${venueId} not found`);
    return formatMoney(amount, venue.currency);
  }
}
