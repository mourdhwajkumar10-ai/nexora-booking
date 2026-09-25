import type {
  AuditLogDto,
  DiningTableDto,
  Locality,
  MenuItemDto,
  ShiftDef,
  ShiftDto,
  VenueCard,
  VenueDetail,
  VenueSettings,
} from '@nexora/shared';
import type { TableRow } from '../../core/tables';
import type { VenueRow } from '../../core/venues';
import { iso } from '../../lib/http';
import { hoursForToday, isOpenAt } from './hours';

/** A venue row joined with its locality label ("Name, City"). */
export type VenueWithLocality = VenueRow & { locality_label: string };

export function toLocality(r: { id: string; slug: string; name: string; city: string }): Locality {
  return { id: r.id, slug: r.slug, name: r.name, city: r.city, label: `${r.name}, ${r.city}` };
}

export function toVenueCard(v: VenueWithLocality, shifts: ShiftDef[], now: Date): VenueCard {
  return {
    id: v.id,
    slug: v.slug,
    name: v.name,
    localityId: v.locality_id,
    localityLabel: v.locality_label,
    address: v.address,
    cuisines: v.cuisines,
    rating: Number(v.rating),
    ratingCount: v.rating_count,
    imageUrl: v.image_url,
    costForOnePaise: v.cost_for_one_paise,
    costForTwoPaise: v.cost_for_two_paise,
    isOpenNow: isOpenAt(shifts, v.timezone, now),
    acceptingBookings: !v.blackout,
    todayHours: hoursForToday(shifts, v.timezone, now),
  };
}

export const toShiftDto = (s: ShiftDef): ShiftDto => ({ dayOfWeek: s.dayOfWeek, openTime: s.openTime, closeTime: s.closeTime });

export function toVenueDetail(v: VenueWithLocality, shifts: ShiftDef[], now: Date): VenueDetail {
  return {
    ...toVenueCard(v, shifts, now),
    description: v.description,
    timezone: v.timezone,
    turnaroundMins: v.turnaround_mins,
    gracePeriodMins: v.grace_period_mins,
    shifts: shifts.map(toShiftDto),
  };
}

export function toVenueSettings(v: VenueWithLocality, shifts: ShiftDef[], now: Date): VenueSettings {
  return {
    ...toVenueDetail(v, shifts, now),
    isActive: v.is_active,
    blackout: v.blackout,
    blackoutReason: v.blackout_reason,
    allowUpsizeFallback: v.allow_upsize_fallback,
    triageTimeoutSecs: v.triage_timeout_secs,
  };
}

export function toTableDto(t: TableRow, upcomingReservations: number): DiningTableDto {
  return {
    id: t.id,
    venueId: t.venue_id,
    tableNumber: t.table_number,
    diningZone: t.dining_zone,
    minCapacity: t.min_capacity,
    maxCapacity: t.max_capacity,
    status: t.status,
    statusChangedAt: iso(t.status_changed_at)!,
    upcomingReservations,
  };
}

export function toMenuItemDto(r: any): MenuItemDto {
  return {
    id: r.id,
    venueId: r.venue_id,
    name: r.name,
    category: r.category,
    pricePaise: r.price_paise,
    isAvailable: r.is_available,
  };
}

export function toAuditLogDto(r: any): AuditLogDto {
  return {
    id: r.id,
    actor: r.actor,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    data: r.data ?? {},
    createdAt: iso(r.created_at)!,
  };
}
