import { parseHm, shiftWindow, utcToZonedParts, type ShiftDef } from '@nexora/shared';

const DAY_MINS = 1440;
const WEEK_MINS = 7 * DAY_MINS;

function previousDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

function shiftSpan(s: ShiftDef): number {
  const span = parseHm(s.closeTime) - parseHm(s.openTime);
  return span <= 0 ? span + DAY_MINS : span;
}

/**
 * Open iff `now` falls in a shift window of today or of yesterday (a shift that started
 * yesterday and closes after midnight is still open now).
 */
export function isOpenAt(shifts: ShiftDef[], timeZone: string, now: Date): boolean {
  const today = utcToZonedParts(now, timeZone);
  const yesterday = previousDate(today.date);
  const days = [
    { date: today.date, dow: today.dayOfWeek },
    { date: yesterday, dow: (today.dayOfWeek + 6) % 7 },
  ];
  const t = now.getTime();
  return days.some(({ date, dow }) =>
    shifts
      .filter((s) => s.dayOfWeek === dow)
      .some((s) => {
        const w = shiftWindow(date, s, timeZone);
        return w.start.getTime() <= t && t < w.end.getTime();
      }),
  );
}

export function hoursForToday(shifts: ShiftDef[], timeZone: string, now: Date): { openTime: string; closeTime: string }[] {
  const { dayOfWeek } = utcToZonedParts(now, timeZone);
  return shifts
    .filter((s) => s.dayOfWeek === dayOfWeek)
    .sort((a, b) => parseHm(a.openTime) - parseHm(b.openTime))
    .map((s) => ({ openTime: s.openTime, closeTime: s.closeTime }));
}

/**
 * First pair of overlapping shifts, or null. Shifts are laid out on a weekly minute timeline so a
 * cross-midnight shift's spill into the next morning (including Sat → Sun) counts as overlap.
 */
export function findShiftOverlap(shifts: ShiftDef[]): [ShiftDef, ShiftDef] | null {
  const spans = shifts.map((s) => {
    const start = s.dayOfWeek * DAY_MINS + parseHm(s.openTime);
    return { s, start, end: start + shiftSpan(s) };
  });
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i];
      const b = spans[j];
      const hit = [-WEEK_MINS, 0, WEEK_MINS].some((shift) => a.start < b.end + shift && b.start + shift < a.end);
      if (hit) return [a.s, b.s];
    }
  }
  return null;
}
