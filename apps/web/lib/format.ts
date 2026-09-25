import { formatINR } from '@nexora/shared';

export { formatINR };

/** "19:30" -> "7:30 PM" */
export function formatTime12(hm: string): string {
  const [h, m] = hm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** "2026-10-02" -> "Fri, 2 Oct" */
export function formatDateShort(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatDateTime(iso: string, timeZone = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(iso));
}

export function formatClock(iso: string, timeZone = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(iso));
}

/** Today's date in a timezone as YYYY-MM-DD. */
export function todayIn(timeZone = 'Asia/Kolkata', offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function relativeFromNow(iso: string, nowMs = Date.now()): string {
  const diff = Math.round((new Date(iso).getTime() - nowMs) / 60000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(diff) < 60) return rtf.format(diff, 'minute');
  return rtf.format(Math.round(diff / 60), 'hour');
}
