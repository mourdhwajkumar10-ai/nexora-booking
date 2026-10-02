'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarX2, ChevronLeft, ChevronRight, Clock, Users } from 'lucide-react';
import type { AvailabilityResponse, SlotAvailability } from '@nexora/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatTime12 } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Segmented, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { BookingForm, EMPTY_BOOKING_FORM, type BookingFormValues } from './booking-form';
import { Notice } from './form-field';
import { groupSlots, SLOT_GROUP_LABEL } from './utils';

export interface BookingDate {
  date: string; // YYYY-MM-DD (venue-local)
  weekday: string; // "Fri"
  day: string; // "2"
  month: string; // "Oct"
  label: string; // "Today" | "Tomorrow" | "Fri, 2 Oct"
  open: boolean; // venue has shifts that weekday
}

const PARTY_OPTIONS = (['1', '2', '3', '4', '5', '6', '7', '8'] as const).map((v) => ({ value: v, label: v }));
const keyOf = (date: string, party: number) => `${date}|${party}`;

export function BookingWidget({
  slug,
  venueName,
  acceptingBookings,
  dates,
  initial,
}: {
  slug: string;
  venueName: string;
  acceptingBookings: boolean;
  dates: BookingDate[];
  initial: AvailabilityResponse | null;
}) {
  const [date, setDate] = useState(initial?.date ?? dates[0].date);
  const [party, setParty] = useState(initial?.partySize ?? 2);
  const [selected, setSelected] = useState<string | null>(null);
  // Lifted so typed contact details survive changing the date or party size.
  const [formValues, setFormValues] = useState<BookingFormValues>(EMPTY_BOOKING_FORM);

  // Availability cache keyed by date|party. `version` bumps invalidate everything (after a 409, on refocus).
  const [results, setResults] = useState<Record<string, AvailabilityResponse>>(() =>
    initial ? { [keyOf(initial.date, initial.partySize)]: initial } : {},
  );
  const fetchedAt = useRef<Record<string, number>>(initial ? { [keyOf(initial.date, initial.partySize)]: 0 } : {});
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const k = keyOf(date, party);
  const data = results[k];

  useEffect(() => {
    if (fetchedAt.current[k] === version) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api<AvailabilityResponse>(`/venues/${encodeURIComponent(slug)}/availability?date=${date}&partySize=${party}`, { signal: ctrl.signal })
      .then((res) => {
        fetchedAt.current[k] = version;
        setResults((r) => ({ ...r, [k]: res }));
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(e instanceof ApiRequestError ? e.message : 'Check your connection and try again.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [k, version, slug, date, party]);

  // Revalidate when the tab regains focus: slots go stale quickly on a busy night.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setVersion((v) => v + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const formRef = useRef<HTMLDivElement>(null);
  const dateScrollRef = useRef<HTMLDivElement>(null);
  const scrollDates = (offset: number) => {
    dateScrollRef.current?.scrollBy({ left: offset, behavior: 'smooth' });
  };

  const selectSlot = (time: string) => {
    setSelected(time);
    requestAnimationFrame(() => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      formRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
    });
  };

  const changeDate = (d: string) => {
    setDate(d);
    setSelected(null);
  };
  const changeParty = (p: number) => {
    setParty(p);
    setSelected(null);
  };

  const dateInfo = dates.find((d) => d.date === date) ?? dates[0];
  const nextOpenDate = dates.find((d) => d.date > date && d.open);

  return (
    <section aria-labelledby="reserve-heading" className="overflow-hidden rounded-xl border border-border bg-background shadow-md">
      <div className="border-b border-border px-5 py-4">
        <h2 id="reserve-heading" className="text-[15px] font-semibold tracking-tight">
          Reserve a table
        </h2>
        <p className="mt-0.5 text-[13px] text-gray-900">Free to book. {venueName} confirms each request.</p>
      </div>

      <div className="min-w-0 space-y-5 px-5 py-5">
        {/* Date chips */}
        <div role="group" aria-labelledby="date-heading" className="min-w-0 max-w-full">
          <div className="mb-2 flex items-center justify-between">
            <span id="date-heading" className="text-[13px] font-medium text-gray-1000">
              Date
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-800 tabular-nums">{dateInfo.label}</span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  aria-label="Scroll dates left"
                  onClick={() => scrollDates(-180)}
                  className="inline-flex size-6 items-center justify-center rounded border border-border bg-background text-gray-700 transition-colors hover:bg-background-2 hover:text-gray-1000"
                >
                  <ChevronLeft size={13} aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label="Scroll dates right"
                  onClick={() => scrollDates(180)}
                  className="inline-flex size-6 items-center justify-center rounded border border-border bg-background text-gray-700 transition-colors hover:bg-background-2 hover:text-gray-1000"
                >
                  <ChevronRight size={13} aria-hidden />
                </button>
              </div>
            </div>
          </div>
          <div className="relative -mx-5 px-5">
            <div
              ref={dateScrollRef}
              className="flex snap-x gap-2 overflow-x-auto pb-1.5 pt-0.5 scroll-smooth [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
              {dates.map((d) => {
                const active = d.date === date;
                return (
                  <button
                    key={d.date}
                    type="button"
                    aria-pressed={active}
                    aria-label={`${d.label}${d.open ? '' : ', closed'}`}
                    onClick={() => changeDate(d.date)}
                    className={cn(
                      'flex h-16 w-14 shrink-0 snap-start touch-manipulation flex-col items-center justify-center rounded-lg border transition-colors duration-150',
                      active
                        ? 'border-gray-1000 bg-gray-1000 text-white'
                        : 'border-border bg-background hover:border-border-strong',
                      !d.open && !active && 'bg-background-2 text-gray-700',
                    )}
                  >
                    <span className={cn('text-[11px] font-medium uppercase tracking-wide', active ? 'text-white/70' : 'text-gray-800')}>
                      {d.label === 'Today' ? 'Today' : d.weekday}
                    </span>
                    <span className="text-lg font-semibold leading-tight tabular-nums">{d.day}</span>
                    <span className={cn('text-[10px]', active ? 'text-white/70' : 'text-gray-800')}>{d.open ? d.month : 'Closed'}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Party size */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span id="party-label" className="flex items-center gap-1.5 text-[13px] font-medium text-gray-1000">
              <Users size={14} aria-hidden className="text-gray-900" />
              Guests
            </span>
            <span className="text-xs text-gray-800 tabular-nums">
              {party} {party === 1 ? 'guest' : 'guests'}
            </span>
          </div>
          <Segmented
            ariaLabel="Party size"
            value={String(party) as (typeof PARTY_OPTIONS)[number]['value']}
            onChange={(v) => changeParty(Number(v))}
            options={PARTY_OPTIONS}
            className="grid w-full grid-cols-8 p-0.5"
            itemClassName="w-full px-0 text-center tabular-nums"
          />
        </div>

        {/* Slots */}
        <div aria-live="polite" aria-busy={loading && !data}>
          {!acceptingBookings ? (
            <Notice tone="amber" title="Not taking online bookings right now">
              {venueName} has paused reservations for the moment. Please check back a little later.
            </Notice>
          ) : error && !data ? (
            <div className="rounded-lg border border-border bg-background-2 px-4 py-6 text-center">
              <p className="text-sm font-medium">Couldn't load times</p>
              <p className="mt-1 text-[13px] text-gray-900">{error}</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={refresh}>
                Try again
              </Button>
            </div>
          ) : !data ? (
            <SlotSkeleton />
          ) : (
            <SlotPicker
              data={data}
              dateLabel={dateInfo.label}
              selected={selected}
              onSelect={selectSlot}
              stale={loading}
              onNextOpen={nextOpenDate ? () => changeDate(nextOpenDate.date) : undefined}
              nextOpenLabel={nextOpenDate?.label}
              party={party}
            />
          )}
        </div>
      </div>

      <div ref={formRef} className="scroll-mt-24">
        {selected && acceptingBookings ? (
          <BookingForm
            slug={slug}
            date={date}
            dateLabel={dateInfo.label}
            time={selected}
            partySize={party}
            values={formValues}
            onValuesChange={setFormValues}
            onChangeTime={setSelected}
            onConflict={refresh}
            onCancel={() => setSelected(null)}
          />
        ) : null}
      </div>
    </section>
  );
}

function SlotSkeleton() {
  return (
    <div aria-label="Loading available times" className="space-y-3">
      <Skeleton className="h-3 w-16" />
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    </div>
  );
}

function SlotPicker({
  data,
  dateLabel,
  selected,
  onSelect,
  stale,
  onNextOpen,
  nextOpenLabel,
  party,
}: {
  data: AvailabilityResponse;
  dateLabel: string;
  selected: string | null;
  onSelect: (t: string) => void;
  stale: boolean;
  onNextOpen?: () => void;
  nextOpenLabel?: string;
  party: number;
}) {
  if (data.blackout) {
    return (
      <Notice tone="amber" title="Not taking bookings on this date">
        The restaurant has paused online reservations. Try another date or check back later.
      </Notice>
    );
  }
  if (data.closed || data.slots.length === 0) {
    return (
      <EmptySlots
        icon={<CalendarX2 size={18} aria-hidden />}
        title={`Closed ${dateLabel === 'Today' || dateLabel === 'Tomorrow' ? dateLabel.toLowerCase() : `on ${dateLabel}`}`}
        description="The kitchen takes a day off. Pick another date."
        action={onNextOpen && nextOpenLabel ? { label: `See ${nextOpenLabel}`, onClick: onNextOpen } : undefined}
      />
    );
  }

  const lastSeating = data.slots[data.slots.length - 1].time;
  const bookable = data.slots.filter((s) => s.available && !s.past);
  const allPast = data.slots.every((s) => s.past);
  const groups = groupSlots(data.slots);

  return (
    <div className={cn('space-y-4 transition-opacity duration-150', stale && 'opacity-60')}>
      {bookable.length === 0 ? (
        <EmptySlots
          icon={<Clock size={18} aria-hidden />}
          title={allPast ? 'No more tables today' : `Fully booked for ${party} ${party === 1 ? 'guest' : 'guests'}`}
          description={allPast ? "Service has wrapped up for today's bookings." : 'Try another date or a different party size.'}
          action={onNextOpen && nextOpenLabel ? { label: `See ${nextOpenLabel}`, onClick: onNextOpen } : undefined}
        />
      ) : null}

      {groups.map((g) => (
        <div key={g.key} role="group" aria-labelledby={`slots-${g.key}`}>
          <p id={`slots-${g.key}`} className="mb-2 font-mono text-[11px] font-medium uppercase tracking-wider text-gray-800">
            {SLOT_GROUP_LABEL[g.key]}
          </p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {g.slots.map((s) => (
              <SlotButton key={s.startAt} slot={s} selected={selected === s.time && s.available && !s.past} onSelect={onSelect} />
            ))}
          </div>
        </div>
      ))}

      <p className="flex items-center gap-1.5 text-[13px] text-gray-900">
        <Clock size={13} aria-hidden />
        Last seating <span className="font-medium text-gray-1000 tabular-nums">{formatTime12(lastSeating)}</span>
        <span className="text-gray-700">· tables turn in {data.turnaroundMins} min</span>
      </p>
    </div>
  );
}

function SlotButton({ slot, selected, onSelect }: { slot: SlotAvailability; selected: boolean; onSelect: (t: string) => void }) {
  const disabled = slot.past || !slot.available;
  const label = formatTime12(slot.time);
  const few = !disabled && slot.tablesLeft === 1;
  const reason = slot.past ? 'past' : !slot.available ? 'fully booked' : few ? 'last table' : 'available';
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      aria-label={`${label}, ${reason}`}
      onClick={() => onSelect(slot.time)}
      className={cn(
        'relative h-10 touch-manipulation rounded-md border text-[13px] font-medium tabular-nums transition-colors duration-150',
        selected
          ? 'border-gray-1000 bg-gray-1000 text-white shadow-sm'
          : 'border-border bg-background text-gray-1000 hover:border-gray-1000',
        disabled && 'cursor-not-allowed border-transparent bg-background-2 text-gray-600 hover:border-transparent',
        slot.past && 'line-through decoration-gray-500',
      )}
    >
      {label}
      {few ? <span aria-hidden className={cn('absolute right-1.5 top-1.5 size-1.5 rounded-full', selected ? 'bg-white' : 'bg-amber')} /> : null}
      {!slot.past && !slot.available ? <span className="sr-only">Full</span> : null}
    </button>
  );
}

function EmptySlots({ icon, title, description, action }: { icon: React.ReactNode; title: string; description: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border px-4 py-7 text-center">
      <span className="mb-2 text-gray-700">{icon}</span>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-xs text-[13px] text-gray-900">{description}</p>
      {action ? (
        <Button variant="secondary" size="sm" className="mt-3" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
