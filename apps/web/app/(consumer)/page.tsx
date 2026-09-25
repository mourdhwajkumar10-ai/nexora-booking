import { Suspense } from 'react';
import type { Locality } from '@nexora/shared';
import { getLocalities, getVenues, resolveLocality } from '@/components/consumer/data';
import { VenueGrid } from '@/components/consumer/venue-grid';
import { VenueGridSkeleton } from '@/components/consumer/venue-card';
import { ErrorState } from '@/components/consumer/error-state';
import { EmptyState } from '@/components/ui/misc';

export default async function DiscoverPage() {
  let localities: Locality[];
  try {
    localities = await getLocalities();
  } catch {
    return (
      <PageShell heading="Tables worth booking">
        <ErrorState />
      </PageShell>
    );
  }
  const locality = await resolveLocality(localities);

  if (!locality) {
    return (
      <PageShell heading="Tables worth booking">
        <EmptyState title="No localities yet" description="Nexora isn't live in any neighbourhood yet. Check back soon." />
      </PageShell>
    );
  }

  return (
    <PageShell heading={`Tables worth booking in ${locality.name}`} subheading={locality.label}>
      {/* Keyed by locality so switching shows the skeleton instead of stale cards. */}
      <Suspense key={locality.slug} fallback={<VenueGridSkeleton />}>
        <VenueResults slug={locality.slug} name={locality.name} />
      </Suspense>
    </PageShell>
  );
}

async function VenueResults({ slug, name }: { slug: string; name: string }) {
  try {
    const venues = await getVenues(slug);
    return <VenueGrid venues={venues} localityName={name} />;
  } catch {
    return <ErrorState title="Couldn't load restaurants" description={`Something went wrong fetching places in ${name}. Please try again.`} />;
  }
}

function PageShell({ heading, subheading, children }: { heading: string; subheading?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <section className="pb-8 pt-12 sm:pb-10 sm:pt-20">
        {subheading ? <p className="mb-3 font-mono text-xs uppercase tracking-wider text-gray-800">{subheading}</p> : null}
        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-[-0.04em] text-gray-1000 sm:text-5xl">{heading}</h1>
        <p className="mt-4 max-w-xl text-pretty text-base text-gray-900 sm:text-lg">
          Hand-picked restaurants near you. Choose a time, request a table, and get confirmed in minutes.
        </p>
      </section>
      {children}
    </div>
  );
}
