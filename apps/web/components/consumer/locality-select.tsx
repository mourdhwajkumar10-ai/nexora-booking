'use client';

import { useOptimistic, useTransition } from 'react';
import { MapPin } from 'lucide-react';
import type { Locality } from '@nexora/shared';
import { setLocality } from '@/app/(consumer)/actions';
import { cn } from '@/lib/cn';
import { Spinner } from '@/components/ui/spinner';

export function LocalitySelect({ localities, value }: { localities: Locality[]; value: string }) {
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useOptimistic(value);

  return (
    <div className="relative min-w-0">
      <label htmlFor="locality" className="sr-only">
        Locality
      </label>
      <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-900">
        {pending ? <Spinner size={14} /> : <MapPin size={14} />}
      </span>
      <select
        id="locality"
        value={current}
        onChange={(e) => {
          const slug = e.target.value;
          startTransition(async () => {
            setCurrent(slug);
            await setLocality(slug);
          });
        }}
        className={cn(
          'h-9 max-w-[52vw] appearance-none truncate rounded-full border border-border bg-background pl-8 pr-8 text-base font-medium text-gray-1000 transition-colors duration-150 sm:max-w-none sm:text-[13px]',
          'hover:border-border-strong hover:bg-background-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        )}
      >
        {localities.map((l) => (
          <option key={l.id} value={l.slug}>
            {l.label}
          </option>
        ))}
      </select>
      <svg aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-900" width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
