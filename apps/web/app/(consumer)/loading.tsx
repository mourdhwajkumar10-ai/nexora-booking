import { Skeleton } from '@/components/ui/misc';
import { VenueGridSkeleton } from '@/components/consumer/venue-card';

export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <div className="pb-8 pt-12 sm:pb-10 sm:pt-20">
        <Skeleton className="mb-4 h-3 w-32" />
        <Skeleton className="h-10 w-full max-w-xl sm:h-12" />
        <Skeleton className="mt-5 h-4 w-full max-w-md" />
      </div>
      <VenueGridSkeleton />
    </div>
  );
}
