/**
 * BR-33 Guest statistics helpers and BR-22 auto-tags, BR-24 lift, BR-28 fees, BR-29 retention.
 */
import { diffDays, type IsoDate } from './time';

/** Median of integers. Even count: floor of the mean of the two middle values. Empty -> null. */
export function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.floor((s[mid - 1]! + s[mid]!) / 2);
}

/** Median gap in days between consecutive DISTINCT visit dates; null with fewer than 2 dates. */
export function medianIntervalDays(visitDates: ReadonlyArray<IsoDate>): number | null {
  const unique = [...new Set(visitDates)].sort();
  if (unique.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < unique.length; i++) gaps.push(diffDays(unique[i]!, unique[i - 1]!));
  return median(gaps);
}

/** Median of the last 10 party sizes (input ordered oldest -> newest). */
export function typicalPartySize(partySizesOldestFirst: ReadonlyArray<number>): number | null {
  return median(partySizesOldestFirst.slice(-10));
}

/** Nearest-rank percentile (p in 0..100). Empty -> null. */
export function percentileThreshold(values: ReadonlyArray<number>, p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[rank - 1]!;
}

export type TagCode =
  | 'FIRST_TIMER'
  | 'REGULAR'
  | 'VIP'
  | 'BIG_SPENDER'
  | 'LAPSED'
  | 'WINE_LOVER'
  | 'BIRTHDAY_THIS_MONTH'
  | 'ALLERGY_ON_FILE';

/** Tags that may never be used to build marketing audiences. */
export const NON_MARKETING_TAGS: ReadonlyArray<TagCode> = ['ALLERGY_ON_FILE'];

export interface GuestVenueStats {
  visitCount: number;
  firstVisitAtMs: number | null;
  lastVisitAtMs: number | null;
  visitsLast90d: number;
  medianIntervalDays: number | null;
  lifetimeSpendCents: number;
  avgCheckPerCoverCents: number | null;
  wineSpendCents: number;
  totalSpendCents: number;
  birthdayMonth: number | null;
  hasAllergies: boolean;
  manualVip: boolean;
}

export interface TagContext {
  nowMs: number;
  /** venue-local month 1..12 */
  localMonth: number;
  /** venue p95 of lifetime spend among guests with >= 2 visits */
  vipLifetimeSpendThresholdCents: number | null;
  /** venue p90 of avg check per cover among guests with >= 3 visits */
  bigSpenderAvgCheckThresholdCents: number | null;
}

const DAY = 86_400_000;

export function evaluateTags(s: GuestVenueStats, ctx: TagContext): TagCode[] {
  const tags: TagCode[] = [];
  if (s.visitCount === 1 && s.firstVisitAtMs !== null && s.firstVisitAtMs >= ctx.nowMs - 30 * DAY) tags.push('FIRST_TIMER');
  if (s.visitsLast90d >= 3) tags.push('REGULAR');
  if (s.manualVip || (ctx.vipLifetimeSpendThresholdCents !== null && s.visitCount >= 2 && s.lifetimeSpendCents >= ctx.vipLifetimeSpendThresholdCents)) tags.push('VIP');
  if (ctx.bigSpenderAvgCheckThresholdCents !== null && s.avgCheckPerCoverCents !== null && s.visitCount >= 3 && s.avgCheckPerCoverCents >= ctx.bigSpenderAvgCheckThresholdCents) tags.push('BIG_SPENDER');
  if (s.visitCount >= 2 && s.lastVisitAtMs !== null) {
    const daysSince = Math.floor((ctx.nowMs - s.lastVisitAtMs) / DAY);
    if (daysSince > Math.max(60, 2 * (s.medianIntervalDays ?? 0))) tags.push('LAPSED');
  }
  if (s.visitCount >= 3 && s.totalSpendCents > 0 && s.wineSpendCents * 100 >= s.totalSpendCents * 30) tags.push('WINE_LOVER');
  if (s.birthdayMonth !== null && s.birthdayMonth === ctx.localMonth) tags.push('BIRTHDAY_THIS_MONTH');
  if (s.hasAllergies) tags.push('ALLERGY_ON_FILE');
  return tags;
}

export interface GroupOutcome {
  n: number;
  conversions: number;
  revenueCents: number;
}

export interface LiftResult {
  treatmentRate: number;
  holdoutRate: number | null;
  incrementalConversions: number | null;
  incrementalRevenueCents: number | null;
  incrementalGrossMarginCents: number | null;
  roi: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  significant: boolean;
}

/** BR-24: incrementality vs holdout with a 95% normal-approximation CI on the rate difference. */
export function computeLift(treatment: GroupOutcome, holdout: GroupOutcome, grossMarginBps: number, costCents: number): LiftResult {
  const rt = treatment.n > 0 ? treatment.conversions / treatment.n : 0;
  if (holdout.n === 0 || treatment.n === 0) {
    return { treatmentRate: rt, holdoutRate: null, incrementalConversions: null, incrementalRevenueCents: null, incrementalGrossMarginCents: null, roi: null, ciLow: null, ciHigh: null, significant: false };
  }
  const rh = holdout.conversions / holdout.n;
  const incrementalConversions = (rt - rh) * treatment.n;
  const incrementalRevenueCents = Math.round((treatment.revenueCents / treatment.n - holdout.revenueCents / holdout.n) * treatment.n);
  const incrementalGrossMarginCents = Math.round((incrementalRevenueCents * grossMarginBps) / 10_000);
  const roi = costCents > 0 ? (incrementalGrossMarginCents - costCents) / costCents : null;
  const se = Math.sqrt((rt * (1 - rt)) / treatment.n + (rh * (1 - rh)) / holdout.n);
  const diff = rt - rh;
  const ciLow = diff - 1.96 * se;
  const ciHigh = diff + 1.96 * se;
  return { treatmentRate: rt, holdoutRate: rh, incrementalConversions, incrementalRevenueCents, incrementalGrossMarginCents, roi, ciLow, ciHigh, significant: ciLow > 0 };
}

export type HoldMode = 'off' | 'all' | 'party_min' | 'not_good_standing';

/** Good standing: at least one completed visit and no confirmed no-show in the last 12 months. */
export function isGoodStanding(completedVisits: number, confirmedNoShowsLast12m: number): boolean {
  return completedVisits >= 1 && confirmedNoShowsLast12m === 0;
}

/** BR-28: whether a card hold is required for a new booking. */
export function holdRequired(mode: HoldMode, partySize: number, partyMin: number | null, goodStanding: boolean): boolean {
  switch (mode) {
    case 'off':
      return false;
    case 'all':
      return true;
    case 'party_min':
      return partyMin !== null && partySize >= partyMin;
    case 'not_good_standing':
      return !goodStanding || (partyMin !== null && partySize >= partyMin);
  }
}

export function feeCents(perCoverCents: number, partySize: number): number {
  return perCoverCents * partySize;
}

export type RetentionClass =
  | 'wifi_session_raw'
  | 'wifi_device'
  | 'guest_profile_inactive'
  | 'consent_record'
  | 'message_content'
  | 'message_metadata'
  | 'pos_raw_event'
  | 'idempotency_key'
  | 'session_expired'
  | 'otp_attempt'
  | 'audit_log'
  | 'dsar_export_file';

/** BR-29 retention in whole days after the reference instant. */
export const RETENTION_DAYS: Readonly<Record<RetentionClass, number>> = {
  wifi_session_raw: 395,
  wifi_device: 365,
  guest_profile_inactive: 1095,
  consent_record: 1826,
  message_content: 395,
  message_metadata: 1826,
  pos_raw_event: 90,
  idempotency_key: 1,
  session_expired: 30,
  otp_attempt: 30,
  audit_log: 2557,
  dsar_export_file: 30,
};

export function purgeAtMs(cls: RetentionClass, referenceMs: number): number {
  return referenceMs + RETENTION_DAYS[cls] * DAY;
}

export type SegmentCondition =
  | { field: 'visit_count'; op: 'gte' | 'lte' | 'eq'; value: number }
  | { field: 'days_since_last_visit'; op: 'gte' | 'lte'; value: number }
  | { field: 'lifetime_spend_cents'; op: 'gte' | 'lte'; value: number }
  | { field: 'avg_check_per_cover_cents'; op: 'gte' | 'lte'; value: number }
  | { field: 'typical_party_size'; op: 'gte' | 'lte' | 'eq'; value: number }
  | { field: 'tag'; op: 'has' | 'not_has'; value: string }
  | { field: 'ordered_item'; op: 'has'; value: string }
  | { field: 'birthday_month'; op: 'eq'; value: number };

export interface SegmentGuestData {
  total_visits?: number;
  totalVisits?: number;
  last_visit_at?: string | Date | number | null;
  lastVisitAt?: string | Date | number | null;
  lifetime_spend_paise?: number;
  lifetimeSpendCents?: number;
  avg_check_per_cover_paise?: number;
  avgCheckPerCoverCents?: number;
  typical_party_size?: number;
  typicalPartySize?: number;
  tags?: string[];
  ordered_items?: string[];
  orderedItems?: string[];
  birthday_month?: number | null;
  birthdayMonth?: number | null;
  birthday?: string | Date | null;
}

/** BR-21: Segment condition evaluation against guest historical metrics */
export function guestMatchesConditions(
  guest: SegmentGuestData,
  conditions: ReadonlyArray<SegmentCondition | any>,
  nowMs: number = Date.now(),
): boolean {
  for (const c of conditions) {
    if (c.field === 'visit_count') {
      const v = guest.total_visits ?? guest.totalVisits ?? 0;
      if (c.op === 'gte' && v < c.value) return false;
      if (c.op === 'lte' && v > c.value) return false;
      if (c.op === 'eq' && v !== c.value) return false;
    } else if (c.field === 'days_since_last_visit') {
      const lastVisit = guest.last_visit_at ?? guest.lastVisitAt;
      if (!lastVisit) return false;
      const lastVisitMs = typeof lastVisit === 'number' ? lastVisit : new Date(lastVisit).getTime();
      const days = Math.floor((nowMs - lastVisitMs) / (24 * 3600_000));
      if (c.op === 'gte' && days < c.value) return false;
      if (c.op === 'lte' && days > c.value) return false;
    } else if (c.field === 'lifetime_spend_cents') {
      const spend = guest.lifetimeSpendCents ?? Math.floor((guest.lifetime_spend_paise ?? 0) / 100);
      if (c.op === 'gte' && spend < c.value) return false;
      if (c.op === 'lte' && spend > c.value) return false;
    } else if (c.field === 'avg_check_per_cover_cents') {
      const visits = guest.total_visits ?? guest.totalVisits ?? 0;
      const avg =
        guest.avgCheckPerCoverCents ??
        Math.floor((guest.avg_check_per_cover_paise ?? (visits ? (guest.lifetime_spend_paise ?? 0) / visits : 0)) / 100);
      if (c.op === 'gte' && avg < c.value) return false;
      if (c.op === 'lte' && avg > c.value) return false;
    } else if (c.field === 'typical_party_size') {
      const size = guest.typical_party_size ?? guest.typicalPartySize ?? 2;
      if (c.op === 'gte' && size < c.value) return false;
      if (c.op === 'lte' && size > c.value) return false;
      if (c.op === 'eq' && size !== c.value) return false;
    } else if (c.field === 'tag') {
      const tags: string[] = guest.tags ?? [];
      const has = tags.includes(c.value);
      if (c.op === 'has' && !has) return false;
      if (c.op === 'not_has' && has) return false;
    } else if (c.field === 'ordered_item') {
      const items: string[] = guest.ordered_items ?? guest.orderedItems ?? [];
      if (c.op === 'has' && !items.includes(c.value)) return false;
    } else if (c.field === 'birthday_month') {
      const bMonth =
        guest.birthday_month ??
        guest.birthdayMonth ??
        (guest.birthday ? new Date(guest.birthday).getMonth() + 1 : null);
      if (bMonth === null || bMonth !== c.value) return false;
    }
  }
  return true;
}

