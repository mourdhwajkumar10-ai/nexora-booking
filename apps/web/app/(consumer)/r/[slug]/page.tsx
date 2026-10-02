import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, Clock, MapPin } from 'lucide-react';
import { dayOfWeekFor, type AvailabilityResponse } from '@nexora/shared';
import { getAvailability, getVenue } from '@/components/consumer/data';
import { BookingWidget, type BookingDate } from '@/components/consumer/booking-widget';
import { CostLine, RatingChip, VenueStatus } from '@/components/consumer/venue-card';
import { hoursLabel, isOptimizableImage } from '@/components/consumer/utils';
import { formatTime12, todayIn } from '@/lib/format';

const DEFAULT_PARTY = 2;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const venue = await getVenue(slug).catch(() => null);
  if (!venue) return { title: 'Restaurant' };
  return { title: venue.name, description: `Reserve a table at ${venue.name}, ${venue.localityLabel}. ${venue.cuisines.join(', ')}.` };
}

function bookingDates(timeZone: string, openDays: Set<number>): BookingDate[] {
  return Array.from({ length: 14 }, (_, i) => {
    const date = todayIn(timeZone, i);
    const [y, m, d] = date.split('-').map(Number);
    const utc = new Date(Date.UTC(y, m - 1, d));
    const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { ...o, timeZone: 'UTC' }).format(utc);
    return {
      date,
      weekday: fmt({ weekday: 'short' }),
      day: String(d),
      month: fmt({ month: 'short' }),
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : fmt({ weekday: 'short', day: 'numeric', month: 'short' }),
      open: openDays.has(dayOfWeekFor(date)),
    };
  });
}

export default async function VenuePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const venue = await getVenue(slug);
  if (!venue) notFound();

  const dates = bookingDates(venue.timezone, new Set((venue.shifts ?? []).map((s) => s.dayOfWeek)));
  const initial = await getAvailability(slug, dates[0].date, DEFAULT_PARTY).catch((): AvailabilityResponse | null => null);

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <nav aria-label="Breadcrumb" className="py-4">
        <Link href="/" className="-ml-2 inline-flex h-8 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-gray-900 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-1000">
          <ChevronLeft size={14} aria-hidden />
          {venue.localityLabel}
        </Link>
      </nav>

      <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-border bg-gray-100 sm:aspect-[21/9]">
        <Image
          src={venue.imageUrl}
          alt={`Inside ${venue.name}`}
          fill
          priority
          sizes="(min-width: 1152px) 1152px, 100vw"
          unoptimized={!isOptimizableImage(venue.imageUrl)}
          className="object-cover"
        />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-12">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <VenueStatus isOpenNow={venue.isOpenNow} acceptingBookings={venue.acceptingBookings} />
            <RatingChip rating={venue.rating} count={venue.ratingCount} />
          </div>
          <h1 className="mt-4 text-balance text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">{venue.name}</h1>
          <p className="mt-2 text-[15px] text-gray-900">{venue.cuisines.join(' · ')}</p>

          <dl className="mt-8 divide-y divide-border rounded-xl border border-border">
            <InfoRow icon={<MapPin size={15} aria-hidden />} label="Address">
              {venue.address}
            </InfoRow>
            <InfoRow icon={<Clock size={15} aria-hidden />} label="Today">
              <span className="tabular-nums">{hoursLabel(venue.todayHours, formatTime12)}</span>
            </InfoRow>
            <InfoRow icon={<span className="text-[15px] leading-none">{venue.currency === 'USD' ? '$' : '₹'}</span>} label="Cost">
              <CostLine one={venue.costForOnePaise} two={venue.costForTwoPaise} currency={venue.currency} className="text-sm" />
            </InfoRow>
          </dl>

          {venue.description ? (
            <section aria-labelledby="about-heading" className="mt-10">
              <h2 id="about-heading" className="text-lg font-semibold tracking-tight">
                About
              </h2>
              <p className="mt-3 max-w-prose whitespace-pre-line text-pretty text-[15px] leading-7 text-gray-900">{venue.description}</p>
            </section>
          ) : null}
        </div>

        <div className="min-w-0 lg:sticky lg:top-24 lg:self-start">
          <BookingWidget slug={venue.slug} venueName={venue.name} acceptingBookings={venue.acceptingBookings} dates={dates} initial={initial} />
        </div>
      </div>
    </div>
  );
}

function InfoRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 px-4 py-3.5">
      <span aria-hidden className="mt-0.5 grid size-5 shrink-0 place-items-center text-gray-900">
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-xs font-medium text-gray-800">{label}</dt>
        <dd className="mt-0.5 text-sm text-gray-1000">{children}</dd>
      </div>
    </div>
  );
}
