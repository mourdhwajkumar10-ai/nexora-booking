'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  ChevronRight,
  Coins,
  History,
  Mail,
  Phone,
  Search,
  Sparkles,
  User,
  Users,
  X,
} from 'lucide-react';
import type { GuestSummary, TierLevel } from '@nexora/shared';
import { adminApi, apiMessage } from '@/components/admin/admin-api';
import { formatDateShort, formatINR } from '@/lib/format';
import {
  Badge,
  BadgeTone,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
} from '@/components/ui';

const TIER_TONES: Record<TierLevel, BadgeTone> = {
  BASE: 'neutral',
  MEMBER: 'blue',
  REGULAR: 'amber',
  FRIENDS_AND_FAMILY: 'accent',
};

const TIER_LABELS: Record<TierLevel, string> = {
  BASE: 'Base Member',
  MEMBER: 'Club Member',
  REGULAR: 'Club Regular',
  FRIENDS_AND_FAMILY: 'Friends & Family',
};

export default function GuestsPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = React.use(params);
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [guests, setGuests] = useState<GuestSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // Debounce search input
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedQuery(query);
    }, 250);
    return () => clearTimeout(handler);
  }, [query]);

  const loadGuests = useCallback(async (searchStr: string) => {
    setLoading(true);
    try {
      const qParam = searchStr.trim() ? `?q=${encodeURIComponent(searchStr.trim())}` : '';
      const data = await adminApi<GuestSummary[]>(`/admin/guests${qParam}`);
      setGuests(data);
    } catch (e) {
      toast.error('Could not load guests', { description: apiMessage(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGuests(debouncedQuery);
  }, [debouncedQuery, loadGuests]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-1000">Guest Directory</h1>
          <p className="mt-1 text-sm text-gray-800">
            Cross-venue CRM profiles, loyalty status, visit history, preferences, and dietary tags.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Badge tone="neutral" className="tabular font-medium text-xs">
            {guests.length} {guests.length === 1 ? 'Guest' : 'Guests'} Listed
          </Badge>
          <Button variant="secondary" size="sm" onClick={() => void loadGuests(query)} loading={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Search Toolbar */}
      <div className="mt-6 flex items-center justify-between rounded-xl border border-border bg-background p-4 shadow-sm">
        <div className="relative w-full max-w-md">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-700" />
          <Input
            type="search"
            placeholder="Search by name, phone number, or email..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9 text-sm"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-700 hover:text-gray-1000"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>

        {query ? (
          <span className="text-xs text-gray-700 italic hidden sm:inline">
            Searching for &ldquo;{query}&rdquo;
          </span>
        ) : null}
      </div>

      {/* Guest Directory Table */}
      <div className="mt-6">
        {loading && guests.length === 0 ? (
          <Card className="p-6">
            <div className="space-y-4">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="flex items-center justify-between border-b border-border pb-4">
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-10 rounded-full" />
                    <div className="space-y-1.5">
                      <Skeleton className="h-4 w-36" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </div>
                  <Skeleton className="h-6 w-20" />
                </div>
              ))}
            </div>
          </Card>
        ) : guests.length === 0 ? (
          <EmptyState
            icon={<Users size={36} className="text-gray-700" />}
            title="No guests found"
            description={
              query
                ? `No guest profiles match the query "${query}".`
                : 'No guests registered yet. Guests are recorded automatically upon booking or walk-in.'
            }
            action={
              query ? (
                <Button variant="secondary" size="sm" onClick={() => setQuery('')}>
                  Clear Search
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-background-2 text-gray-800 font-medium">
                    <th className="px-5 py-3">Guest Profile</th>
                    <th className="px-4 py-3">Phone & Email</th>
                    <th className="px-4 py-3">Loyalty Tier</th>
                    <th className="px-4 py-3 text-center">Visits</th>
                    <th className="px-4 py-3 text-right">Lifetime Spend</th>
                    <th className="px-4 py-3">Last Visit</th>
                    <th className="px-4 py-3">Tags & Notes</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {guests.map((g) => {
                    const tierLabel = TIER_LABELS[g.tier] ?? g.tier;
                    const tierTone = TIER_TONES[g.tier] ?? 'neutral';

                    return (
                      <tr
                        key={g.id}
                        onClick={() => router.push(`/admin/${venueId}/guests/${g.id}`)}
                        className="group cursor-pointer hover:bg-background-2/70 transition-colors"
                      >
                        {/* Guest Name & Avatar */}
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <div className="flex items-center gap-3">
                            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gray-100 border border-border text-gray-900 font-semibold text-xs">
                              {g.name
                                .split(' ')
                                .map((n) => n[0])
                                .slice(0, 2)
                                .join('')
                                .toUpperCase() || <User size={13} />}
                            </div>
                            <div>
                              <span className="font-semibold text-gray-1000 group-hover:text-accent group-hover:underline block text-sm">
                                {g.name}
                              </span>
                              {g.hasAllergies ? (
                                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-fg">
                                  <AlertTriangle size={11} /> Allergies
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </td>

                        {/* Phone & Email */}
                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <div className="flex flex-col gap-0.5 text-gray-900 tabular">
                            <span className="inline-flex items-center gap-1">
                              <Phone size={11} className="text-gray-700" />
                              {g.phone}
                            </span>
                            {g.email ? (
                              <span className="inline-flex items-center gap-1 text-gray-700 text-[11px]">
                                <Mail size={11} className="text-gray-700" />
                                {g.email}
                              </span>
                            ) : null}
                          </div>
                        </td>

                        {/* Loyalty Tier */}
                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <Badge tone={tierTone} className="font-medium">
                            {tierLabel}
                          </Badge>
                        </td>

                        {/* Total Visits */}
                        <td className="px-4 py-3.5 text-center whitespace-nowrap">
                          <span className="inline-flex items-center gap-1 font-semibold text-gray-1000 tabular">
                            <History size={12} className="text-gray-700" />
                            {g.totalVisits}
                          </span>
                        </td>

                        {/* Lifetime Spend */}
                        <td className="px-4 py-3.5 text-right whitespace-nowrap">
                          <span className="font-semibold text-gray-1000 tabular">
                            {formatINR(g.lifetimeSpendPaise)}
                          </span>
                        </td>

                        {/* Last Visit Date */}
                        <td className="px-4 py-3.5 whitespace-nowrap text-gray-800">
                          {g.lastVisitAt ? (
                            <span className="inline-flex items-center gap-1 tabular">
                              <Calendar size={12} className="text-gray-700" />
                              {formatDateShort(g.lastVisitAt.slice(0, 10))}
                            </span>
                          ) : (
                            <span className="text-gray-700 italic">Never</span>
                          )}
                        </td>

                        {/* Tags */}
                        <td className="px-4 py-3.5">
                          {g.tags && g.tags.length > 0 ? (
                            <div className="flex flex-wrap gap-1 max-w-xs">
                              {g.tags.slice(0, 3).map((t) => (
                                <Badge key={t} tone="neutral" className="text-[10px] h-4 px-1.5">
                                  {t}
                                </Badge>
                              ))}
                              {g.tags.length > 3 ? (
                                <span className="text-[10px] text-gray-700 tabular">
                                  +{g.tags.length - 3} more
                                </span>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-gray-700 italic text-[11px]">—</span>
                          )}
                        </td>

                        {/* Action link */}
                        <td className="px-4 py-3.5 text-right whitespace-nowrap">
                          <span className="inline-flex items-center gap-0.5 text-xs font-medium text-gray-700 group-hover:text-accent">
                            View <ChevronRight size={14} />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
