'use client';

import { useMemo, useState } from 'react';
import { UtensilsCrossed } from 'lucide-react';
import type { VenueCard as VenueCardDto } from '@nexora/shared';
import { cn } from '@/lib/cn';
import { EmptyState } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { VenueCard } from './venue-card';

const ALL = '__all__';

/** Cuisine chips (client-side filter) + responsive grid. */
export function VenueGrid({ venues, localityName }: { venues: VenueCardDto[]; localityName: string }) {
  const [cuisine, setCuisine] = useState(ALL);

  const cuisines = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of venues) for (const c of v.cuisines) counts.set(c, (counts.get(c) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  }, [venues]);

  const visible = cuisine === ALL ? venues : venues.filter((v) => v.cuisines.includes(cuisine));

  if (venues.length === 0) {
    return (
      <EmptyState
        icon={<UtensilsCrossed size={20} />}
        title={`No restaurants in ${localityName} yet`}
        description="We're onboarding new places every week. Try another locality from the menu above."
      />
    );
  }

  return (
    <div>
      {cuisines.length > 1 ? (
        <div role="group" aria-label="Filter by cuisine" className="-mx-4 mb-6 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
          {[ALL, ...cuisines].map((c) => {
            const active = c === cuisine;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={active}
                onClick={() => setCuisine(c)}
                className={cn(
                  'h-8 shrink-0 touch-manipulation rounded-full border px-3.5 text-[13px] font-medium transition-colors duration-150',
                  active ? 'border-gray-1000 bg-gray-1000 text-white' : 'border-border bg-background text-gray-900 hover:border-border-strong hover:text-gray-1000',
                )}
              >
                {c === ALL ? 'All' : c}
              </button>
            );
          })}
        </div>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {visible.length} {visible.length === 1 ? 'restaurant' : 'restaurants'} shown
      </p>

      {visible.length === 0 ? (
        <EmptyState
          title={`No ${cuisine} restaurants here`}
          description="Try a different cuisine."
          action={
            <Button variant="secondary" size="sm" onClick={() => setCuisine(ALL)}>
              Show all
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((v, i) => (
            <div key={v.id} className="animate-fade-in">
              <VenueCard venue={v} priority={i < 3} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
