'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Clock,
  Coins,
  CreditCard,
  Heart,
  History,
  Info,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Smartphone,
  Sparkles,
  Tag,
  Trash2,
  TrendingUp,
  User,
  Users,
  Utensils,
  Wallet,
  Wifi,
  X,
} from 'lucide-react';
import type { GuestProfileDto, LedgerEntryDto, TierLevel } from '@nexora/shared';
import { adminApi, apiMessage, rupeesToPaise, send } from '@/components/admin/admin-api';
import { useConsole } from '@/components/admin/console-provider';
import { formatDateShort, formatDateTime, formatINR } from '@/lib/format';
import {
  Badge,
  BadgeTone,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Field,
  Input,
  Label,
  Select,
  Skeleton,
  StatusBadge,
  Textarea,
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

export default function GuestDetailPage({
  params,
}: {
  params: Promise<{ venueId: string; guestId: string }>;
}) {
  const { venueId, guestId } = React.use(params);
  const { isManager, emit } = useConsole();

  const [guest, setGuest] = useState<GuestProfileDto | null>(null);
  const [ledger, setLedger] = useState<LedgerEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  // Edit preferences form
  const [preferencesForm, setPreferencesForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    seatingPreference: 'ANY',
    dietaryNotes: '',
    allergies: '',
  });
  const [savingPreferences, setSavingPreferences] = useState(false);

  // Tag creation state
  const [newTagInput, setNewTagInput] = useState('');
  const [addingTag, setAddingTag] = useState(false);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);

  // Wallet Preload state
  const [preloadModalOpen, setPreloadModalOpen] = useState(false);
  const [preloadAmountRupees, setPreloadAmountRupees] = useState('5000');
  const [submittingPreload, setSubmittingPreload] = useState(false);

  const loadGuestData = useCallback(async () => {
    try {
      const data = await adminApi<GuestProfileDto>(`/admin/guests/${guestId}`);
      setGuest(data);
      setPreferencesForm({
        firstName: data.firstName || '',
        lastName: data.lastName || '',
        email: data.email || '',
        seatingPreference: data.seatingPreference || 'ANY',
        dietaryNotes: data.dietaryNotes || '',
        allergies: data.allergies || '',
      });
    } catch (e) {
      toast.error('Could not load guest profile', { description: apiMessage(e) });
    } finally {
      setLoading(false);
    }
  }, [guestId]);

  const loadLedger = useCallback(async () => {
    setLedgerLoading(true);
    try {
      const data = await adminApi<LedgerEntryDto[]>(`/admin/guests/${guestId}/ledger`);
      setLedger(data);
    } catch {
      // Ignore if ledger fails or guest has no account
    } finally {
      setLedgerLoading(false);
    }
  }, [guestId]);

  useEffect(() => {
    void loadGuestData();
    void loadLedger();
  }, [loadGuestData, loadLedger]);

  const handleSavePreferences = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPreferences(true);
    try {
      const updated = await send<GuestProfileDto>('PATCH', `/admin/guests/${guestId}`, {
        firstName: preferencesForm.firstName.trim() || undefined,
        lastName: preferencesForm.lastName.trim() || undefined,
        email: preferencesForm.email.trim() || null,
        seatingPreference: preferencesForm.seatingPreference,
        dietaryNotes: preferencesForm.dietaryNotes.trim() || null,
        allergies: preferencesForm.allergies.trim() || null,
      });
      setGuest(updated);
      toast.success('Guest preferences updated successfully');
    } catch (err) {
      toast.error('Failed to update preferences', { description: apiMessage(err) });
    } finally {
      setSavingPreferences(false);
    }
  };

  const handleAddTag = async (e: React.FormEvent) => {
    e.preventDefault();
    const tag = newTagInput.trim().toUpperCase().replace(/\s+/g, '_');
    if (!tag) return;
    setAddingTag(true);
    try {
      const updated = await send<GuestProfileDto>('POST', `/admin/guests/${guestId}/tags`, {
        tagName: tag,
      });
      setGuest(updated);
      setNewTagInput('');
      toast.success(`Tag "${tag}" added`);
    } catch (err) {
      toast.error('Failed to add tag', { description: apiMessage(err) });
    } finally {
      setAddingTag(false);
    }
  };

  const handleDeleteTag = async (tagName: string) => {
    setDeletingTag(tagName);
    try {
      const updated = await send<GuestProfileDto>(
        'DELETE',
        `/admin/guests/${guestId}/tags/${encodeURIComponent(tagName)}`,
      );
      setGuest(updated);
      toast.info(`Tag "${tagName}" removed`);
    } catch (err) {
      toast.error('Failed to delete tag', { description: apiMessage(err) });
    } finally {
      setDeletingTag(null);
    }
  };

  const handlePreloadWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    const paise = rupeesToPaise(preloadAmountRupees);
    if (!Number.isFinite(paise) || paise <= 0) {
      toast.error('Enter a valid amount in ₹');
      return;
    }

    setSubmittingPreload(true);
    try {
      const updated = await send<GuestProfileDto>(
        'POST',
        `/admin/guests/${guestId}/wallet/preload`,
        { amountPaise: paise },
      );
      setGuest(updated);
      setPreloadModalOpen(false);
      toast.success(`Preloaded ${formatINR(paise)} into wallet`, {
        description: `New wallet balance: ${formatINR(updated.loyalty.walletBalancePaise)}. Tier: ${updated.loyalty.tier}`,
      });
      void loadLedger();
    } catch (err) {
      toast.error('Preload failed', { description: apiMessage(err) });
    } finally {
      setSubmittingPreload(false);
    }
  };

  if (loading || !guest) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 space-y-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  const tier = guest.loyalty.tier;
  const tierTone = TIER_TONES[tier] ?? 'neutral';
  const tierLabel = TIER_LABELS[tier] ?? tier;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 space-y-8">
      {/* Top Breadcrumb & Navigation */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Link
            href={`/admin/${venueId}/guests`}
            className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-background text-gray-800 hover:bg-background-2 transition-colors"
          >
            <ArrowLeft size={16} />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-gray-1000">{guest.name}</h1>
              <Badge tone={tierTone}>{tierLabel}</Badge>
            </div>
            <p className="text-xs text-gray-700 mt-0.5 tabular">
              Joined {formatDateTime(guest.createdAt)} · Phone: {guest.phone}
              {guest.email ? ` · Email: ${guest.email}` : ''}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isManager ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setPreloadModalOpen(true)}
              className="gap-1.5"
            >
              <Wallet size={14} /> Preload Wallet
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void loadGuestData();
              void loadLedger();
            }}
          >
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>
      </div>

      {/* Loyalty Overview Banner */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-r from-gray-1000 to-[#262626] p-6 text-white shadow-md">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wider text-gray-400">
              Nexora Club Membership
            </span>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-bold tracking-tight text-white">{tierLabel}</h2>
              <Badge tone={tierTone} className="text-xs px-2.5">
                {guest.loyalty.multiplier}x Points Multiplier
              </Badge>
            </div>
            <p className="text-xs text-gray-300 max-w-lg mt-1">
              Earns {guest.loyalty.multiplier} reward points per ₹1 spent. Points can be redeemed for folio credits during dining settlement.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 border-t border-white/10 pt-4 md:border-t-0 md:pt-0">
            <div className="rounded-lg bg-white/5 p-3.5 backdrop-blur-sm border border-white/10">
              <span className="block text-[11px] font-medium text-gray-400">Points Balance</span>
              <span className="mt-1 block text-lg font-bold text-white tabular">
                {guest.loyalty.pointsBalance.toLocaleString('en-IN')} pts
              </span>
            </div>

            <div className="rounded-lg bg-white/5 p-3.5 backdrop-blur-sm border border-white/10">
              <span className="block text-[11px] font-medium text-gray-400">Wallet Stored Value</span>
              <span className="mt-1 block text-lg font-bold text-emerald-400 tabular">
                {formatINR(guest.loyalty.walletBalancePaise)}
              </span>
            </div>

            <div className="col-span-2 sm:col-span-1 rounded-lg bg-white/5 p-3.5 backdrop-blur-sm border border-white/10">
              <span className="block text-[11px] font-medium text-gray-400">Annual Spend</span>
              <span className="mt-1 block text-lg font-bold text-amber-300 tabular">
                {formatINR(guest.loyalty.annualSpendPaise)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardBody className="p-4">
            <span className="text-xs text-gray-700 font-medium block">Total Visits</span>
            <span className="mt-1 text-2xl font-bold text-gray-1000 tabular block">
              {guest.totalVisits}
            </span>
            <span className="text-[11px] text-gray-700 mt-0.5 block">Lifetime visits recorded</span>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-4">
            <span className="text-xs text-gray-700 font-medium block">Average Party Size</span>
            <span className="mt-1 text-2xl font-bold text-gray-1000 tabular block">
              {guest.avgPartySize ? guest.avgPartySize.toFixed(1) : '1.0'}
            </span>
            <span className="text-[11px] text-gray-700 mt-0.5 block">Guests per booking</span>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-4">
            <span className="text-xs text-gray-700 font-medium block">No-Shows</span>
            <span className="mt-1 text-2xl font-bold text-red-fg tabular block">
              {guest.noShowCount}
            </span>
            <span className="text-[11px] text-gray-700 mt-0.5 block">Missed reservations</span>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-4">
            <span className="text-xs text-gray-700 font-medium block">Voids & Comps</span>
            <span className="mt-1 text-2xl font-bold text-gray-1000 tabular block">
              {formatINR(guest.totalVoidsValuePaise)}
            </span>
            <span className="text-[11px] text-gray-700 mt-0.5 block tabular">
              {guest.totalVoidsCount} adjustments
            </span>
          </CardBody>
        </Card>
      </div>

      {/* Main Grid: Preferences & Tags */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        {/* Column 1 & 2: Guest Preferences & Profile */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Guest Preferences & CRM Details</CardTitle>
                <p className="text-xs text-gray-700 mt-0.5">
                  Update personal contact info, table preferences, and medical allergy records.
                </p>
              </div>
            </CardHeader>

            <CardBody>
              <form onSubmit={(e) => void handleSavePreferences(e)} className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="First Name" htmlFor="pref-firstname">
                    <Input
                      id="pref-firstname"
                      value={preferencesForm.firstName}
                      onChange={(e) =>
                        setPreferencesForm((p) => ({ ...p, firstName: e.target.value }))
                      }
                    />
                  </Field>

                  <Field label="Last Name" htmlFor="pref-lastname">
                    <Input
                      id="pref-lastname"
                      value={preferencesForm.lastName}
                      onChange={(e) =>
                        setPreferencesForm((p) => ({ ...p, lastName: e.target.value }))
                      }
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Email Address" htmlFor="pref-email">
                    <Input
                      id="pref-email"
                      type="email"
                      placeholder="guest@example.com"
                      value={preferencesForm.email}
                      onChange={(e) =>
                        setPreferencesForm((p) => ({ ...p, email: e.target.value }))
                      }
                    />
                  </Field>

                  <Field label="Seating Preference" htmlFor="pref-seating">
                    <Select
                      id="pref-seating"
                      value={preferencesForm.seatingPreference}
                      onChange={(e) =>
                        setPreferencesForm((p) => ({ ...p, seatingPreference: e.target.value }))
                      }
                    >
                      <option value="ANY">No Preference</option>
                      <option value="BOOTH">Booth</option>
                      <option value="WINDOW">Window View</option>
                      <option value="QUIET">Quiet / Intimate</option>
                      <option value="PATIO">Patio / Outdoor</option>
                    </Select>
                  </Field>
                </div>

                <Field
                  label="Allergies (Highlighted with High Visibility)"
                  htmlFor="pref-allergies"
                  hint="Allergies trigger bold red warnings in triage and floor cards."
                >
                  <Input
                    id="pref-allergies"
                    placeholder="e.g. Peanut, Shellfish, Gluten, Dairy"
                    value={preferencesForm.allergies}
                    onChange={(e) =>
                      setPreferencesForm((p) => ({ ...p, allergies: e.target.value }))
                    }
                  />
                </Field>

                <Field label="Dietary Notes & General Preferences" htmlFor="pref-dietary">
                  <Textarea
                    id="pref-dietary"
                    placeholder="e.g. Vegan, prefers mineral water room temperature, table away from draft"
                    rows={3}
                    value={preferencesForm.dietaryNotes}
                    onChange={(e) =>
                      setPreferencesForm((p) => ({ ...p, dietaryNotes: e.target.value }))
                    }
                  />
                </Field>

                <div className="flex justify-end pt-2">
                  <Button type="submit" variant="primary" size="sm" loading={savingPreferences} className="gap-1.5">
                    <Save size={14} /> Save Preferences
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>

          {/* Loyalty Ledger */}
          <Card>
            <CardHeader className="justify-between">
              <div>
                <CardTitle>Loyalty & Stored Value Ledger</CardTitle>
                <p className="text-xs text-gray-700 mt-0.5">
                  Audited accruals, redemptions, wallet preloads, and reversals.
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void loadLedger()} loading={ledgerLoading}>
                <RefreshCw size={13} />
              </Button>
            </CardHeader>

            <CardBody className="p-0">
              {ledger.length === 0 ? (
                <div className="p-6 text-center text-xs text-gray-700 italic">
                  No loyalty ledger transactions recorded yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border bg-background-2 text-gray-800 font-medium">
                        <th className="px-4 py-2.5">Date</th>
                        <th className="px-4 py-2.5">Event</th>
                        <th className="px-4 py-2.5 text-right">Points</th>
                        <th className="px-4 py-2.5 text-right">Amount</th>
                        <th className="px-4 py-2.5">Note</th>
                        <th className="px-4 py-2.5">State</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {ledger.map((entry) => (
                        <tr key={entry.id} className="hover:bg-background-2/50">
                          <td className="px-4 py-2.5 whitespace-nowrap text-gray-700 tabular">
                            {formatDateTime(entry.createdAt)}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <Badge
                              tone={
                                entry.eventType === 'ACCRUAL'
                                  ? 'green'
                                  : entry.eventType === 'PRELOAD'
                                  ? 'accent'
                                  : entry.eventType === 'REDEMPTION'
                                  ? 'amber'
                                  : 'neutral'
                              }
                              className="text-[10px] h-4 px-1.5"
                            >
                              {entry.eventType}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5 text-right whitespace-nowrap tabular font-medium">
                            {entry.pointsDelta > 0 ? (
                              <span className="text-success font-semibold">+{entry.pointsDelta}</span>
                            ) : entry.pointsDelta < 0 ? (
                              <span className="text-red font-semibold">{entry.pointsDelta}</span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right whitespace-nowrap tabular font-medium">
                            {entry.amountPaise ? formatINR(entry.amountPaise) : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-gray-800 max-w-xs truncate">
                            {entry.note || '—'}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="text-[11px] text-gray-700 font-mono">
                              {entry.state}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        {/* Column 3: Tags, Wi-Fi, Affinities */}
        <div className="space-y-6">
          {/* Tags Management */}
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Tags Management</CardTitle>
                <p className="text-xs text-gray-700 mt-0.5">Auto-generated or custom staff tags.</p>
              </div>
            </CardHeader>
            <CardBody className="space-y-4">
              <form onSubmit={(e) => void handleAddTag(e)} className="flex gap-2">
                <Input
                  placeholder="e.g. WINE_LOVER, VIP"
                  value={newTagInput}
                  onChange={(e) => setNewTagInput(e.target.value)}
                  className="h-8 text-xs"
                />
                <Button type="submit" variant="secondary" size="sm" loading={addingTag} className="h-8 px-2.5">
                  <Plus size={14} /> Add
                </Button>
              </form>

              <div className="flex flex-wrap gap-1.5">
                {guest.tagDetails && guest.tagDetails.length > 0 ? (
                  guest.tagDetails.map((t) => (
                    <span
                      key={t.tagName}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-background-2 px-2.5 py-1 text-xs font-medium text-gray-900"
                    >
                      <Tag size={11} className="text-gray-700" />
                      <span>{t.tagName}</span>
                      <span className="text-[10px] text-gray-700">
                        {t.isAutoGenerated ? '(Auto)' : '(Staff)'}
                      </span>
                      {!t.isAutoGenerated ? (
                        <button
                          type="button"
                          disabled={deletingTag === t.tagName}
                          onClick={() => void handleDeleteTag(t.tagName)}
                          className="ml-1 text-gray-700 hover:text-red transition-colors"
                        >
                          <X size={12} />
                        </button>
                      ) : null}
                    </span>
                  ))
                ) : (
                  <p className="text-xs text-gray-700 italic">No tags assigned yet.</p>
                )}
              </div>
            </CardBody>
          </Card>

          {/* Wi-Fi Devices */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Wifi size={16} className="text-gray-800" />
                <CardTitle>Registered Wi-Fi Devices</CardTitle>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {guest.devices && guest.devices.length > 0 ? (
                <div className="divide-y divide-border">
                  {guest.devices.map((dev) => (
                    <div key={dev.mac} className="flex items-center justify-between p-3.5 text-xs">
                      <div>
                        <span className="font-mono font-medium text-gray-1000 block">
                          {dev.mac}
                        </span>
                        <span className="text-[11px] text-gray-700 block mt-0.5">
                          First seen: {formatDateShort(dev.firstSeenAt.slice(0, 10))}
                        </span>
                      </div>
                      <span className="text-[11px] text-gray-700 tabular">
                        Last: {formatDateShort(dev.lastSeenAt.slice(0, 10))}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4 text-center text-xs text-gray-700 italic">
                  No devices recorded via guest Wi-Fi captive portal.
                </div>
              )}
            </CardBody>
          </Card>

          {/* Item Affinities */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Utensils size={16} className="text-gray-800" />
                <CardTitle>Top Item Affinities</CardTitle>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {guest.itemAffinities && guest.itemAffinities.length > 0 ? (
                <div className="divide-y divide-border">
                  {guest.itemAffinities.map((item, idx) => (
                    <div key={item.itemName} className="flex items-center justify-between p-3.5 text-xs">
                      <div className="flex items-center gap-2.5">
                        <span className="flex size-5 items-center justify-center rounded-full bg-gray-100 text-[10px] font-bold text-gray-800">
                          #{idx + 1}
                        </span>
                        <span className="font-medium text-gray-1000">{item.itemName}</span>
                      </div>
                      <Badge tone="neutral" className="tabular text-[11px]">
                        {item.quantity} orders
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4 text-center text-xs text-gray-700 italic">
                  No ordered dishes recorded in POS yet.
                </div>
              )}
            </CardBody>
          </Card>

          {/* Reservations History */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <History size={16} className="text-gray-800" />
                <CardTitle>Reservation History</CardTitle>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              {guest.reservations && guest.reservations.length > 0 ? (
                <div className="divide-y divide-border max-h-80 overflow-y-auto">
                  {guest.reservations.map((r) => (
                    <div key={r.id} className="p-3.5 text-xs flex items-center justify-between">
                      <div>
                        <span className="font-medium text-gray-1000 block">{r.venueName}</span>
                        <span className="text-[11px] text-gray-700 tabular block mt-0.5">
                          {formatDateTime(r.startAt)} · {r.partySize} covers
                        </span>
                      </div>
                      <StatusBadge status={r.status} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4 text-center text-xs text-gray-700 italic">
                  No past bookings.
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Wallet Preload Modal */}
      <Dialog
        open={preloadModalOpen}
        onClose={() => setPreloadModalOpen(false)}
        title="Preload Guest Wallet"
        description={`Add stored-value balance to ${guest.name}'s account. Preloads unlock higher tiers immediately.`}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPreloadModalOpen(false)}
              disabled={submittingPreload}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submittingPreload}
              onClick={(e) => void handlePreloadWallet(e)}
            >
              Confirm Preload
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => void handlePreloadWallet(e)} className="space-y-4">
          <Field label="Preload Amount (₹ INR)" htmlFor="preload-amount">
            <Input
              id="preload-amount"
              type="number"
              min="100"
              step="100"
              required
              value={preloadAmountRupees}
              onChange={(e) => setPreloadAmountRupees(e.target.value)}
              className="font-semibold text-lg"
            />
          </Field>

          {/* Quick preset buttons */}
          <div className="flex flex-wrap gap-2">
            {[1000, 2500, 5000, 10000, 25000].map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => setPreloadAmountRupees(String(amt))}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  preloadAmountRupees === String(amt)
                    ? 'border-gray-1000 bg-gray-1000 text-white'
                    : 'border-border bg-background hover:bg-background-2 text-gray-800'
                }`}
              >
                ₹{amt.toLocaleString('en-IN')}
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-border bg-background-2 p-3 text-xs text-gray-800 space-y-1">
            <div className="flex justify-between">
              <span className="text-gray-700">Current Balance:</span>
              <span className="font-semibold text-gray-1000 tabular">
                {formatINR(guest.loyalty.walletBalancePaise)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-700">New Balance:</span>
              <span className="font-bold text-emerald-600 tabular">
                {formatINR(
                  guest.loyalty.walletBalancePaise + (rupeesToPaise(preloadAmountRupees) || 0),
                )}
              </span>
            </div>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
