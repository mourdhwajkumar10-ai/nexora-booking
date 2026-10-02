/**
 * Scheduling & Time Math.
 * Combines venue scheduling math (date-fns-tz) with BR-02 Calendar/Instant math (Intl API).
 *
 * Vocabulary
 * - IsoDate: calendar date 'YYYY-MM-DD' with no time zone.
 * - minuteOfDay: WALL-CLOCK minutes after local midnight of a service date.
 *   Values >= 1440 mean "after midnight, next calendar day" (e.g. 1530 = 01:30 next day).
 * - Instants are JavaScript Date objects or epoch milliseconds (UTC).
 */
import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz';
import { SLOT_INTERVAL_MINS } from './constants';

/* =========================================================================
 * BR-02 Pure Intl Time Rules (Plan Pack Reference)
 * ========================================================================= */

export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export function parseIsoDate(date: IsoDate): DateParts {
  const m = ISO_DATE.exec(date);
  if (!m) throw new Error(`Invalid ISO date: ${date}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Invalid ISO date: ${date}`);
  }
  return { year, month, day };
}

export function formatIsoDate(year: number, month: number, day: number): IsoDate {
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Adds (or subtracts) whole calendar days. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return formatIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Returns a - b in whole calendar days. */
export function diffDays(a: IsoDate, b: IsoDate): number {
  const pa = parseIsoDate(a);
  const pb = parseIsoDate(b);
  return Math.round((Date.UTC(pa.year, pa.month - 1, pa.day) - Date.UTC(pb.year, pb.month - 1, pb.day)) / MS_PER_DAY);
}

/** 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(date: IsoDate): number {
  const { year, month, day } = parseIsoDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  date: IsoDate;
  /** 0..1439 */
  minuteOfDay: number;
  second: number;
  /** 0 = Sunday */
  dayOfWeek: number;
  /** 1..12 */
  month: number;
}

/** Converts an instant to wall-clock parts in the given IANA time zone. */
export function toLocalParts(instant: Date | number, tz: string): LocalParts {
  const d = typeof instant === 'number' ? new Date(instant) : instant;
  const parts = formatterFor(tz).formatToParts(d);
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`Missing ${type} in formatted date`);
    return Number(p.value);
  };
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  const date = formatIsoDate(year, month, day);
  return { date, minuteOfDay: hour * 60 + minute, second, dayOfWeek: dayOfWeek(date), month };
}

/** Offset of the zone at the instant, in ms (local wall clock minus UTC). */
export function zoneOffsetMs(instant: number, tz: string): number {
  const p = toLocalParts(instant, tz);
  const { year, month, day } = parseIsoDate(p.date);
  const wallAsUtc = Date.UTC(year, month - 1, day, Math.floor(p.minuteOfDay / 60), p.minuteOfDay % 60, p.second);
  const truncated = Math.floor(instant / 1000) * 1000;
  return wallAsUtc - truncated;
}

/**
 * Converts a service date + wall-clock minute offset to an instant.
 * - minuteOfDay may be >= 1440 (after midnight on the following calendar day).
 * - Non-existent local time (spring-forward gap): shifted forward by the gap (02:30 -> 03:30).
 * - Ambiguous local time (fall-back overlap): the EARLIER instant is returned.
 */
export function localToInstant(serviceDate: IsoDate, minuteOfDay: number, tz: string): Date {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0) throw new Error(`Invalid minuteOfDay: ${minuteOfDay}`);
  const dayShift = Math.floor(minuteOfDay / 1440);
  const minute = minuteOfDay - dayShift * 1440;
  const date = addDays(serviceDate, dayShift);
  const { year, month, day } = parseIsoDate(date);
  const wallUtc = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60, 0);
  const offsetBefore = zoneOffsetMs(wallUtc - MS_PER_DAY, tz);
  const offsetAfter = zoneOffsetMs(wallUtc + MS_PER_DAY, tz);
  const candidates = Array.from(new Set([wallUtc - offsetBefore, wallUtc - offsetAfter])).sort((a, b) => a - b);
  for (const c of candidates) {
    const p = toLocalParts(c, tz);
    if (p.date === date && p.minuteOfDay === minute) return new Date(c);
  }
  return new Date(wallUtc - offsetBefore);
}

/**
 * Service date an instant belongs to. Times before `cutoffMinute` (default 04:00 = 240)
 * belong to the previous service date. Matches Toast's default closeout hour.
 */
export function serviceDateFor(instant: Date | number, tz: string, cutoffMinute = 240): IsoDate {
  const p = toLocalParts(instant, tz);
  return p.minuteOfDay < cutoffMinute ? addDays(p.date, -1) : p.date;
}

/** Wall-clock minute offset of an instant relative to the given service date (may be >= 1440). */
export function minuteOffsetFrom(serviceDate: IsoDate, instant: Date | number, tz: string): number {
  const p = toLocalParts(instant, tz);
  return diffDays(p.date, serviceDate) * 1440 + p.minuteOfDay;
}

/** Formats minutes as 'HH:MM' (wall clock, wraps after 24h). */
export function formatMinute(minuteOfDay: number): string {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/* =========================================================================
 * Venue Scheduling & Dwell Math (Existing Shared Functions)
 * ========================================================================= */

export interface Interval {
  start: Date;
  end: Date;
}

export interface ShiftDef {
  dayOfWeek: number; // 0 = Sunday
  openTime: string; // "HH:mm" or "HH:mm:ss"
  closeTime: string;
}

export function parseHm(t: string): number {
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) throw new Error(`Invalid time "${t}"`);
  return h * 60 + m;
}

export function formatHm(mins: number): string {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function addMinutes(d: Date, mins: number): Date {
  return new Date(d.getTime() + mins * 60_000);
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

export function maxIntervalsPerShift(openTime: string, closeTime: string, turnaroundMins: number): number {
  let span = parseHm(closeTime) - parseHm(openTime);
  if (span <= 0) span += 1440;
  return Math.floor(span / turnaroundMins);
}

/** Convert a venue-local date ("YYYY-MM-DD") + wall time ("HH:mm") to a UTC instant. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const hm = time.length === 5 ? `${time}:00` : time;
  return fromZonedTime(`${date}T${hm}`, timeZone);
}

export function utcToZonedParts(d: Date, timeZone: string): { date: string; time: string; dayOfWeek: number } {
  const z = toZonedTime(d, timeZone);
  return {
    date: formatInTimeZone(d, timeZone, 'yyyy-MM-dd'),
    time: formatInTimeZone(d, timeZone, 'HH:mm'),
    dayOfWeek: z.getDay(),
  };
}

export function dayOfWeekFor(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Absolute [open, close) window for a shift on a given local date. */
export function shiftWindow(date: string, shift: ShiftDef, timeZone: string): Interval {
  const start = zonedToUtc(date, shift.openTime.slice(0, 5), timeZone);
  let span = parseHm(shift.closeTime) - parseHm(shift.openTime);
  if (span <= 0) span += 1440;
  return { start, end: addMinutes(start, span) };
}

/**
 * All bookable slot start times ("HH:mm") for a date: every 15 min from open while
 * start + turnaround <= close (so the last slot is close - turnaround; CRITIQUE #13).
 */
export function generateSlots(
  date: string,
  shifts: ShiftDef[],
  turnaroundMins: number,
  timeZone: string,
  interval = SLOT_INTERVAL_MINS,
): { time: string; start: Date; end: Date }[] {
  const dow = dayOfWeekFor(date);
  const out: { time: string; start: Date; end: Date }[] = [];
  for (const s of shifts.filter((x) => x.dayOfWeek === dow)) {
    const w = shiftWindow(date, s, timeZone);
    for (let t = w.start; addMinutes(t, turnaroundMins).getTime() <= w.end.getTime(); t = addMinutes(t, interval)) {
      out.push({ time: formatInTimeZone(t, timeZone, 'HH:mm'), start: t, end: addMinutes(t, turnaroundMins) });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Validate a requested start against the shift boundaries and 15-minute grid. */
export function validateRequestedSlot(
  date: string,
  time: string,
  shifts: ShiftDef[],
  turnaroundMins: number,
  timeZone: string,
): { ok: true; start: Date; end: Date } | { ok: false; reason: 'OFF_GRID' | 'OUTSIDE_HOURS' } {
  if (parseHm(time) % SLOT_INTERVAL_MINS !== 0) return { ok: false, reason: 'OFF_GRID' };
  const slot = generateSlots(date, shifts, turnaroundMins, timeZone).find((s) => s.time === time);
  if (!slot) return { ok: false, reason: 'OUTSIDE_HOURS' };
  return { ok: true, start: slot.start, end: slot.end };
}

/** Elapsed seconds using a server-clock offset (serverNow - clientNow) to keep drift < 1s. */
export function elapsedSeconds(since: string | Date, clientNowMs: number, serverOffsetMs = 0): number {
  const s = typeof since === 'string' ? Date.parse(since) : since.getTime();
  return Math.max(0, Math.floor((clientNowMs + serverOffsetMs - s) / 1000));
}

export type DwellLevel = 'normal' | 'amber' | 'red';
export function dwellLevel(elapsedSecs: number, turnaroundMins: number, redExtraMins = 15): DwellLevel {
  if (elapsedSecs >= (turnaroundMins + redExtraMins) * 60) return 'red';
  if (elapsedSecs >= turnaroundMins * 60) return 'amber';
  return 'normal';
}

export function formatElapsed(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
