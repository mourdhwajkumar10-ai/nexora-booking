import Image from 'next/image';
import Link from 'next/link';
import { Star } from 'lucide-react';
import type { VenueCard as VenueCardDto } from '@nexora/shared';
import { formatINR } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Skeleton } from '@/components/ui/misc';
import { isOptimizableImage } from './utils';

export function RatingChip({ rating, count, className }: { rating: number; count: number; className?: string }) {
  return (
    <span
      className={cn('inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-1.5 text-xs font-medium tabular-nums', className)}
      aria-label={`Rated ${rating.toFixed(1)} out of 5 from ${count.toLocaleString('en-IN')} reviews`}
    >
      <Star size={12} aria-hidden className="fill-gray-1000 text-gray-1000" />
      {rating.toFixed(1)}
      <span className="text-gray-800">({count.toLocaleString('en-IN')})</span>
    </span>
  );
}

export function VenueStatus({ isOpenNow, acceptingBookings }: { isOpenNow: boolean; acceptingBookings: boolean }) {
  if (!acceptingBookings) {
    return (
      <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-amber/25 bg-amber-soft px-2.5 text-xs font-medium text-amber-fg">
        Not taking bookings
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium',
        isOpenNow ? 'border-success/20 bg-success-soft text-success-fg' : 'border-border bg-gray-100 text-gray-900',
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', isOpenNow ? 'bg-success' : 'bg-gray-700')} />
      {isOpenNow ? 'Open now' : 'Closed now'}
    </span>
  );
}

export function CostLine({ one, two, className }: { one: number; two: number; className?: string }) {
  return (
    <p className={cn('text-[13px] text-gray-900 tabular-nums', className)}>
      Cost for one <span className="font-medium text-gray-1000">{formatINR(one)}</span>
      <span aria-hidden className="px-1.5 text-gray-600">·</span>
      for two <span className="font-medium text-gray-1000">{formatINR(two)}</span>
    </p>
  );
}

export function VenueCard({ venue, priority }: { venue: VenueCardDto; priority?: boolean }) {
  return (
    <Link
      href={`/r/${venue.slug}`}
      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-[box-shadow,border-color] duration-150 hover:border-border-strong hover:shadow-md focus-visible:outline-offset-4"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-gray-100">
        <Image
          src={venue.imageUrl}
          alt=""
          fill
          priority={priority}
          sizes="(min-width: 1024px) 360px, (min-width: 640px) 50vw, 100vw"
          unoptimized={!isOptimizableImage(venue.imageUrl)}
          className={cn(
            'object-cover transition-transform duration-300 ease-out motion-safe:group-hover:scale-[1.02]',
            !venue.acceptingBookings && 'grayscale-[40%]',
          )}
        />
        <div className="absolute left-3 top-3">
          <VenueStatus isOpenNow={venue.isOpenNow} acceptingBookings={venue.acceptingBookings} />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">{venue.name}</h3>
          <RatingChip rating={venue.rating} count={venue.ratingCount} className="shrink-0" />
        </div>
        <p className="truncate text-[13px] text-gray-900">{venue.cuisines.join(' · ')}</p>
        <CostLine one={venue.costForOnePaise} two={venue.costForTwoPaise} className="mt-auto pt-1" />
      </div>
    </Link>
  );
}

export function VenueCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background">
      <Skeleton className="aspect-[16/10] rounded-none" />
      <div className="space-y-3 p-4">
        <div className="flex justify-between gap-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-12" />
        </div>
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    </div>
  );
}

export function VenueGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading restaurants" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <VenueCardSkeleton key={i} />
      ))}
    </div>
  );
}
