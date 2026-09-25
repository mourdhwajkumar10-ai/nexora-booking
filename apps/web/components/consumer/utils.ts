import type { SlotAvailability, TierLevel } from '@nexora/shared';

/** next/image only optimises allow-listed hosts (next.config); anything else is served as-is. */
export function isOptimizableImage(src: string): boolean {
  try {
    return new URL(src).hostname === 'images.unsplash.com';
  } catch {
    return false;
  }
}

export type SlotGroupKey = 'lunch' | 'dinner' | 'late';
export const SLOT_GROUP_LABEL: Record<SlotGroupKey, string> = { lunch: 'Lunch', dinner: 'Dinner', late: 'Late' };

/** Lunch: 05:00–15:59 · Dinner: 16:00–21:59 · Late: 22:00–04:59 (after-midnight slots stay in order). */
export function slotGroup(time: string): SlotGroupKey {
  const h = Number(time.slice(0, 2));
  if (h >= 5 && h < 16) return 'lunch';
  if (h >= 16 && h < 22) return 'dinner';
  return 'late';
}

export function groupSlots(slots: SlotAvailability[]) {
  const groups: { key: SlotGroupKey; slots: SlotAvailability[] }[] = [];
  for (const s of slots) {
    const key = slotGroup(s.time);
    const g = groups.find((x) => x.key === key);
    if (g) g.slots.push(s);
    else groups.push({ key, slots: [s] });
  }
  return groups;
}

export const TIER_LABEL: Record<TierLevel, string> = {
  BASE: 'Guest',
  MEMBER: 'Member',
  REGULAR: 'Regular',
  FRIENDS_AND_FAMILY: 'Friends & Family',
};

/** "7:30 PM – 11:00 PM" style hours string for today's shifts. */
export function hoursLabel(hours: { openTime: string; closeTime: string }[], fmt: (hm: string) => string): string {
  if (hours.length === 0) return 'Closed today';
  return hours.map((h) => `${fmt(h.openTime.slice(0, 5))} – ${fmt(h.closeTime.slice(0, 5))}`).join(', ');
}

/** Build an RFC 5545 calendar file as a data URL (all times in UTC). */
export function icsDataUrl(ev: { uid: string; title: string; start: string; end: string; location: string; description: string }): string {
  const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nexora//Reservations//EN',
    'BEGIN:VEVENT',
    `UID:${ev.uid}@nexora`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(ev.start)}`,
    `DTEND:${stamp(ev.end)}`,
    `SUMMARY:${esc(ev.title)}`,
    `LOCATION:${esc(ev.location)}`,
    `DESCRIPTION:${esc(ev.description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join('\r\n'))}`;
}
