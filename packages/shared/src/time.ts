/**
 * Scheduling math (PRD §Mathematical Pacing and Overlap Formulations).
 *
 *   T_end = T_start + T_turn                         (release boundary)
 *   valid iff T_start >= T_open  AND  T_end <= T_close
 *   N_max = floor((T_close - T_open) / T_turn)       (non-overlapping intervals per table)
 *   conflict([s1,e1), [s2,e2)) iff s1 < e2 AND s2 < e1
 *
 * Wall-clock times ("HH:mm") are interpreted in the venue's IANA timezone. A shift whose
 * close_time <= open_time is treated as crossing midnight (CRITIQUE #4).
 */
import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz';
import { SLOT_INTERVAL_MINS } from './constants';

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
