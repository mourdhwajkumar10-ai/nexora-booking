import { Skeleton } from '@/components/ui/misc';

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading restaurant" className="mx-auto max-w-6xl px-4 sm:px-6">
      <div className="py-4">
        <Skeleton className="h-8 w-32" />
      </div>
      <Skeleton className="aspect-[4/3] w-full rounded-xl sm:aspect-[21/9]" />
      <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-12">
        <div className="space-y-4">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-8 h-40 w-full rounded-xl" />
        </div>
        <Skeleton className="h-[480px] w-full rounded-xl" />
      </div>
    </div>
  );
}
