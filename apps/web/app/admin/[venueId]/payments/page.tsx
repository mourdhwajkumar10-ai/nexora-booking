'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Coins,
  Copy,
  CreditCard,
  Gift,
  History,
  Lock,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  User,
  Wallet,
  X,
} from 'lucide-react';
import type { GiftCardDto, GuestSummary } from '@nexora/shared';
import { adminApi, apiMessage, rupeesToPaise, send } from '@/components/admin/admin-api';
import { useConsole } from '@/components/admin/console-provider';
import { formatDateTime, formatINR } from '@/lib/format';
import {
  Badge,
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
} from '@/components/ui';

export default function PaymentsPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = React.use(params);
  const { isManager } = useConsole();

  const [cards, setCards] = useState<GiftCardDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Issue Card Modal State
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [issueAmountRupees, setIssueAmountRupees] = useState('2000');
  const [purchaserGuestId, setPurchaserGuestId] = useState('');
  const [guestList, setGuestList] = useState<GuestSummary[]>([]);
  const [submittingIssue, setSubmittingIssue] = useState(false);

  // Issued Card Reveal Modal
  const [revealedCard, setRevealedCard] = useState<{
    cardNumber: string;
    last4: string;
    amountPaise: number;
    purchasedBy: string | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Reload Modal State
  const [reloadModalCard, setReloadModalCard] = useState<GiftCardDto | null>(null);
  const [manualLast4, setManualLast4] = useState('');
  const [reloadAmountRupees, setReloadAmountRupees] = useState('1000');
  const [submittingReload, setSubmittingReload] = useState(false);

  const loadCards = useCallback(async () => {
    try {
      const data = await adminApi<GiftCardDto[]>(`/admin/venues/${venueId}/gift-cards`);
      setCards(data);
    } catch (e) {
      toast.error('Could not load gift cards', { description: apiMessage(e) });
    } finally {
      setLoading(false);
    }
  }, [venueId]);

  const loadGuests = useCallback(async () => {
    try {
      const data = await adminApi<GuestSummary[]>('/admin/guests');
      setGuestList(data);
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    void loadCards();
    void loadGuests();
  }, [loadCards, loadGuests]);

  // Handle Issue Gift Card
  const handleIssueCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isManager) {
      toast.error('Manager privileges required to issue gift cards');
      return;
    }

    const paise = rupeesToPaise(issueAmountRupees);
    if (!Number.isFinite(paise) || paise <= 0) {
      toast.error('Enter a valid amount in ₹');
      return;
    }

    setSubmittingIssue(true);
    try {
      const issued = await send<GiftCardDto>('POST', '/admin/gift-cards', {
        amountPaise: paise,
        purchasedByGuestId: purchaserGuestId || undefined,
      });

      setIssueModalOpen(false);
      setIssueAmountRupees('2000');
      setPurchaserGuestId('');

      if (issued.cardNumber) {
        setRevealedCard({
          cardNumber: issued.cardNumber,
          last4: issued.last4,
          amountPaise: issued.balancePaise,
          purchasedBy: issued.purchasedBy,
        });
      } else {
        toast.success(`Gift card issued (${formatINR(issued.balancePaise)})`);
      }

      void loadCards();
    } catch (err) {
      toast.error('Failed to issue gift card', { description: apiMessage(err) });
    } finally {
      setSubmittingIssue(false);
    }
  };

  // Handle Reload
  const handleReloadCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isManager) {
      toast.error('Manager privileges required to reload gift cards');
      return;
    }

    const targetLast4 = reloadModalCard ? reloadModalCard.last4 : manualLast4.trim();
    if (!targetLast4) {
      toast.error('Enter the card 4-digit identifier or last-4');
      return;
    }

    const paise = rupeesToPaise(reloadAmountRupees);
    if (!Number.isFinite(paise) || paise <= 0) {
      toast.error('Enter a valid reload amount in ₹');
      return;
    }

    setSubmittingReload(true);
    try {
      const updated = await send<GiftCardDto>(
        'POST',
        `/admin/gift-cards/${encodeURIComponent(targetLast4)}/reload`,
        { amountPaise: paise },
      );

      toast.success(`Gift card •••• ${updated.last4} reloaded`, {
        description: `Added ${formatINR(paise)}. New balance: ${formatINR(updated.balancePaise)}`,
      });

      setReloadModalCard(null);
      setManualLast4('');
      setReloadAmountRupees('1000');
      void loadCards();
    } catch (err) {
      toast.error('Reload failed', { description: apiMessage(err) });
    } finally {
      setSubmittingReload(false);
    }
  };

  const handleCopyCard = () => {
    if (!revealedCard) return;
    navigator.clipboard.writeText(revealedCard.cardNumber);
    setCopied(true);
    toast.success('Card number copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  // Summary Metrics
  const totalBalancePaise = useMemo(
    () => cards.reduce((sum, c) => sum + (c.balancePaise || 0), 0),
    [cards],
  );

  const filteredCards = useMemo(() => {
    if (!searchQuery.trim()) return cards;
    const q = searchQuery.toLowerCase().trim();
    return cards.filter(
      (c) =>
        c.last4.includes(q) ||
        (c.purchasedBy && c.purchasedBy.toLowerCase().includes(q)),
    );
  }, [cards, searchQuery]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 space-y-8">
      {/* Top Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-gray-1000">Gift Cards & Stored Value</h1>
            {!isManager ? (
              <Badge tone="slate" className="gap-1 text-xs">
                <Lock size={12} /> Host (View Only)
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-gray-800">
            Issue 16-digit cryptographic stored-value gift cards, manage top-ups, and track active balances.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isManager ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setReloadModalCard(null);
                  setManualLast4('');
                  setReloadAmountRupees('1000');
                  setReloadModalCard({ id: '', last4: '', balancePaise: 0, purchasedBy: null, createdAt: '' });
                }}
                className="gap-1.5"
              >
                <TrendingUp size={14} /> Reload Card
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setIssueModalOpen(true)}
                className="gap-1.5"
              >
                <Plus size={15} /> Issue New Card
              </Button>
            </>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => void loadCards()} loading={loading}>
            <RefreshCw size={14} />
          </Button>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardBody className="p-5">
            <span className="text-xs font-medium text-gray-700 block">Total Active Cards</span>
            <span className="mt-1 text-2xl font-bold text-gray-1000 tabular block">
              {cards.length}
            </span>
            <span className="text-[11px] text-gray-700 mt-0.5 block">Stored-value cards issued</span>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-5">
            <span className="text-xs font-medium text-gray-700 block">Total Stored Value</span>
            <span className="mt-1 text-2xl font-bold text-emerald-600 tabular block">
              {formatINR(totalBalancePaise)}
            </span>
            <span className="text-[11px] text-gray-700 mt-0.5 block">Aggregate outstanding card balance</span>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-5">
            <span className="text-xs font-medium text-gray-700 block">Average Card Balance</span>
            <span className="mt-1 text-2xl font-bold text-gray-1000 tabular block">
              {cards.length > 0 ? formatINR(Math.round(totalBalancePaise / cards.length)) : '₹0'}
            </span>
            <span className="text-[11px] text-gray-700 mt-0.5 block">Per active card holder</span>
          </CardBody>
        </Card>
      </div>

      {/* Search & Table */}
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-xl border border-border bg-background p-4 shadow-sm">
          <div className="relative w-full max-w-sm">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-700" />
            <Input
              type="search"
              placeholder="Search by last-4 digits or purchaser name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>

          <span className="text-xs text-gray-700 tabular">
            Showing {filteredCards.length} {filteredCards.length === 1 ? 'card' : 'cards'}
          </span>
        </div>

        {loading && cards.length === 0 ? (
          <Card className="p-6">
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="flex justify-between border-b border-border pb-3">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-5 w-24" />
                </div>
              ))}
            </div>
          </Card>
        ) : filteredCards.length === 0 ? (
          <EmptyState
            icon={<Gift size={36} className="text-gray-700" />}
            title="No gift cards found"
            description={
              searchQuery
                ? `No gift cards match "${searchQuery}".`
                : 'No gift cards have been issued yet. Click "Issue New Card" to generate your first stored value card.'
            }
            action={
              isManager ? (
                <Button variant="primary" size="sm" onClick={() => setIssueModalOpen(true)}>
                  Issue First Gift Card
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
                    <th className="px-5 py-3">Card Identifier</th>
                    <th className="px-4 py-3">Purchaser / Holder</th>
                    <th className="px-4 py-3 text-right">Available Balance</th>
                    <th className="px-4 py-3">Issued Date</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredCards.map((card) => (
                    <tr key={card.id} className="hover:bg-background-2/50 transition-colors">
                      {/* Card Number Masked */}
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <div className="flex items-center gap-2.5">
                          <div className="flex size-7 items-center justify-center rounded-md bg-gray-100 border border-border text-gray-800">
                            <CreditCard size={14} />
                          </div>
                          <div>
                            <span className="font-mono font-semibold text-gray-1000 tabular block">
                              •••• •••• •••• {card.last4}
                            </span>
                            <span className="text-[10px] text-gray-700 font-mono">
                              BIN: 6011
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Purchaser */}
                      <td className="px-4 py-3.5 whitespace-nowrap text-gray-900">
                        {card.purchasedBy ? (
                          <span className="font-medium text-gray-1000 inline-flex items-center gap-1.5">
                            <User size={13} className="text-gray-700" />
                            {card.purchasedBy}
                          </span>
                        ) : (
                          <span className="text-gray-700 italic">Guest / Over-the-counter</span>
                        )}
                      </td>

                      {/* Balance */}
                      <td className="px-4 py-3.5 text-right whitespace-nowrap font-bold text-gray-1000 tabular text-sm">
                        {formatINR(card.balancePaise)}
                      </td>

                      {/* Created */}
                      <td className="px-4 py-3.5 whitespace-nowrap text-gray-700 tabular">
                        {formatDateTime(card.createdAt)}
                      </td>

                      {/* Action */}
                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        {isManager ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setReloadModalCard(card);
                              setReloadAmountRupees('1000');
                            }}
                            className="h-7 px-2.5 text-xs"
                          >
                            <TrendingUp size={12} className="mr-1" /> Reload
                          </Button>
                        ) : (
                          <span className="text-gray-700 italic text-[11px]">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Issue Card Modal */}
      <Dialog
        open={issueModalOpen}
        onClose={() => setIssueModalOpen(false)}
        title="Issue New Gift Card"
        description="Generates a 16-digit stored value card number starting with BIN 6011. Preload with credit."
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIssueModalOpen(false)}
              disabled={submittingIssue}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submittingIssue}
              onClick={(e) => void handleIssueCard(e)}
            >
              Issue Gift Card
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => void handleIssueCard(e)} className="space-y-4">
          <Field label="Card Balance Amount (₹ INR)" htmlFor="issue-amt">
            <Input
              id="issue-amt"
              type="number"
              min="100"
              step="100"
              required
              value={issueAmountRupees}
              onChange={(e) => setIssueAmountRupees(e.target.value)}
              className="text-base font-semibold"
            />
          </Field>

          {/* Quick presets */}
          <div className="flex flex-wrap gap-2">
            {[500, 1000, 2000, 5000, 10000].map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => setIssueAmountRupees(String(amt))}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  issueAmountRupees === String(amt)
                    ? 'border-gray-1000 bg-gray-1000 text-white'
                    : 'border-border bg-background hover:bg-background-2 text-gray-800'
                }`}
              >
                ₹{amt.toLocaleString('en-IN')}
              </button>
            ))}
          </div>

          <Field label="Purchaser Guest Profile (Optional)" htmlFor="issue-guest" hint="Links gift card purchase to guest CRM history.">
            <Select
              id="issue-guest"
              value={purchaserGuestId}
              onChange={(e) => setPurchaserGuestId(e.target.value)}
            >
              <option value="">-- Anonymous / Direct Walk-In Purchase --</option>
              {guestList.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.phone})
                </option>
              ))}
            </Select>
          </Field>
        </form>
      </Dialog>

      {/* One-Time Card Reveal Modal */}
      <Dialog
        open={Boolean(revealedCard)}
        onClose={() => setRevealedCard(null)}
        title="Gift Card Issued Successfully"
        description="Share or copy the 16-digit card number now. For security, this full card PAN is never stored in plain text."
        footer={
          <Button variant="primary" size="sm" onClick={() => setRevealedCard(null)}>
            Done
          </Button>
        }
      >
        {revealedCard ? (
          <div className="space-y-5">
            {/* Virtual Card Graphic */}
            <div className="relative overflow-hidden rounded-xl border border-gray-800 bg-gradient-to-br from-gray-1000 via-[#262626] to-black p-6 text-white shadow-lg">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm tracking-wider uppercase text-gray-400">
                  Nexora Gift Card
                </span>
                <Sparkles size={18} className="text-amber-400" />
              </div>

              <div className="my-6">
                <span className="font-mono text-xl sm:text-2xl font-bold tracking-widest text-emerald-400 block select-all">
                  {revealedCard.cardNumber.replace(/(\d{4})/g, '$1 ').trim()}
                </span>
              </div>

              <div className="flex items-end justify-between border-t border-white/10 pt-3 text-xs">
                <div>
                  <span className="text-[10px] text-gray-400 uppercase block">Available Balance</span>
                  <span className="text-base font-bold text-white tabular">
                    {formatINR(revealedCard.amountPaise)}
                  </span>
                </div>

                <div className="text-right">
                  <span className="text-[10px] text-gray-400 uppercase block">Holder</span>
                  <span className="font-medium text-white truncate max-w-[140px] block">
                    {revealedCard.purchasedBy || 'Valued Guest'}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border bg-background-2 p-3">
              <div className="font-mono text-sm font-semibold text-gray-1000">
                {revealedCard.cardNumber}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCopyCard}
                className="gap-1.5 text-xs"
              >
                {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy PAN'}
              </Button>
            </div>

            <div className="flex items-start gap-2.5 rounded-lg border border-amber/30 bg-amber-soft p-3 text-xs text-amber-fg">
              <ShieldAlert size={16} className="shrink-0 mt-0.5" />
              <div>
                <span className="font-bold block">One-Time Cryptographic Reveal</span>
                <span>
                  The server stores only a SHA-256 hash. Once you close this modal, only the last 4 digits (•••• {revealedCard.last4}) will be visible.
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </Dialog>

      {/* Reload Card Modal */}
      <Dialog
        open={Boolean(reloadModalCard)}
        onClose={() => setReloadModalCard(null)}
        title="Reload Gift Card"
        description={
          reloadModalCard && reloadModalCard.last4
            ? `Add funds to card ending in •••• ${reloadModalCard.last4}.`
            : 'Enter the card 4-digit identifier and reload amount.'
        }
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReloadModalCard(null)}
              disabled={submittingReload}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submittingReload}
              onClick={(e) => void handleReloadCard(e)}
            >
              Confirm Reload
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => void handleReloadCard(e)} className="space-y-4">
          {!reloadModalCard?.last4 ? (
            <Field label="Card Last-4 Digits" htmlFor="reload-last4">
              <Input
                id="reload-last4"
                placeholder="e.g. 6011"
                maxLength={4}
                required
                value={manualLast4}
                onChange={(e) => setManualLast4(e.target.value)}
                className="font-mono text-sm"
              />
            </Field>
          ) : (
            <div className="rounded-lg border border-border bg-background-2 p-3 text-xs">
              <span className="text-gray-700 block">Target Card:</span>
              <span className="font-mono font-bold text-gray-1000 text-sm">
                •••• •••• •••• {reloadModalCard.last4}
              </span>
              <span className="text-gray-700 block mt-1 tabular">
                Current Balance: <strong>{formatINR(reloadModalCard.balancePaise)}</strong>
              </span>
            </div>
          )}

          <Field label="Reload Amount (₹ INR)" htmlFor="reload-amt">
            <Input
              id="reload-amt"
              type="number"
              min="100"
              step="100"
              required
              value={reloadAmountRupees}
              onChange={(e) => setReloadAmountRupees(e.target.value)}
              className="text-base font-semibold"
            />
          </Field>

          {/* Quick presets */}
          <div className="flex flex-wrap gap-2">
            {[500, 1000, 2500, 5000].map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => setReloadAmountRupees(String(amt))}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  reloadAmountRupees === String(amt)
                    ? 'border-gray-1000 bg-gray-1000 text-white'
                    : 'border-border bg-background hover:bg-background-2 text-gray-800'
                }`}
              >
                ₹{amt.toLocaleString('en-IN')}
              </button>
            ))}
          </div>
        </form>
      </Dialog>
    </div>
  );
}
