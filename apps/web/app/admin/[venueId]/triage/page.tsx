'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Clock,
  Users,
  CheckCircle2,
  XCircle,
  Calendar,
  Sparkles,
  Phone,
  Mail,
  ShieldAlert,
  ArrowRight,
  Info,
} from 'lucide-react';
import type { AdminReservation } from '@nexora/shared';
import { adminApi, apiMessage, send } from '@/components/admin/admin-api';
import { useConsole } from '@/components/admin/console-provider';
import { useServerNow } from '@/components/admin/clock';
import { formatTime12, formatDateShort } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Label,
  Skeleton,
  Textarea,
} from '@/components/ui';

function formatRemaining(ms: number): { text: string; isOverdue: boolean; isUrgent: boolean } {
  if (ms <= 0) {
    const overdueSecs = Math.abs(Math.floor(ms / 1000));
    const m = Math.floor(overdueSecs / 60);
    const s = overdueSecs % 60;
    return {
      text: m > 0 ? `Overdue by ${m}m ${s}s` : `Overdue by ${s}s`,
      isOverdue: true,
      isUrgent: true,
    };
  }
  const totalSecs = Math.floor(ms / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return {
    text: `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
    isOverdue: false,
    isUrgent: totalSecs <= 60,
  };
}

function getTierDisplay(guest: AdminReservation['guest']) {
  if (guest.totalVisits === 0) {
    return { label: 'FIRST TIME', tone: 'blue' as const };
  }
  if (guest.tier === 'FRIENDS_AND_FAMILY' || guest.tier === 'REGULAR') {
    return { label: 'VIP', tone: 'amber' as const };
  }
  if (guest.tier === 'MEMBER') {
    return { label: 'REGULAR', tone: 'green' as const };
  }
  return { label: guest.tier ?? 'REGULAR', tone: 'neutral' as const };
}

export default function TriagePage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = React.use(params);
  const { subscribe, emit } = useConsole();
  const serverNow = useServerNow();

  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  // Reject dialog state
  const [rejectDialogItem, setRejectDialogItem] = useState<AdminReservation | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [submittingReject, setSubmittingReject] = useState(false);

  const loadTriage = useCallback(async () => {
    try {
      const data = await adminApi<AdminReservation[]>(`/admin/venues/${venueId}/triage`);
      // Sort oldest first
      data.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      setReservations(data);
    } catch (e) {
      toast.error('Failed to load triage queue', { description: apiMessage(e) });
    } finally {
      setLoading(false);
    }
  }, [venueId]);

  useEffect(() => {
    void loadTriage();
    return subscribe(['reservation:changed', 'poll'], () => void loadTriage());
  }, [loadTriage, subscribe]);

  const handleApprove = async (res: AdminReservation) => {
    setActionLoadingId(res.id);
    try {
      await send('POST', `/admin/reservations/${res.id}/approve`);
      toast.success(`Booking approved for ${res.guest.name}`, {
        description: `${formatDateShort(res.date)} at ${formatTime12(res.time)} (Party of ${res.partySize})`,
      });
      emit('reservation:changed');
      void loadTriage();
    } catch (e) {
      toast.error('Approval failed', { description: apiMessage(e) });
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleConfirmReject = async () => {
    if (!rejectDialogItem) return;
    setSubmittingReject(true);
    try {
      await send('POST', `/admin/reservations/${rejectDialogItem.id}/reject`, {
        reason: rejectReason.trim() || undefined,
      });
      toast.info(`Booking declined for ${rejectDialogItem.guest.name}`);
      setRejectDialogItem(null);
      setRejectReason('');
      emit('reservation:changed');
      void loadTriage();
    } catch (e) {
      toast.error('Decline failed', { description: apiMessage(e) });
    } finally {
      setSubmittingReject(false);
    }
  };

  const nowMs = serverNow || Date.now();

  const escalatedCount = useMemo(
    () => reservations.filter((r) => r.escalatedAt != null).length,
    [reservations],
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-gray-1000">Triage Queue</h1>
            <Badge tone={reservations.length > 0 ? 'amber' : 'neutral'} dot>
              {reservations.length} Pending
            </Badge>
            {escalatedCount > 0 ? (
              <Badge tone="red" dot className="animate-pulse">
                {escalatedCount} Escalated
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-gray-800">
            Review incoming online reservation requests oldest first. Requests escalate automatically when the deadline expires.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => void loadTriage()} loading={loading}>
            Refresh
          </Button>
          <Link href={`/admin/${venueId}/reservations`}>
            <Button variant="ghost" size="sm" className="gap-1.5 text-gray-900">
              View All Bookings <ArrowRight size={14} />
            </Button>
          </Link>
        </div>
      </div>

      {/* Main Content */}
      <div className="mt-8">
        {loading && reservations.length === 0 ? (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i} className="animate-pulse p-6">
                <div className="flex justify-between">
                  <Skeleton className="h-6 w-36" />
                  <Skeleton className="h-6 w-20" />
                </div>
                <div className="mt-4 space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-10 w-full" />
                </div>
              </Card>
            ))}
          </div>
        ) : reservations.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 size={40} className="text-success" />}
            title="Triage queue is clear"
            description="All booking requests have been reviewed. New online requests will appear here in real time."
            action={
              <Link href={`/admin/${venueId}/reservations`}>
                <Button variant="secondary" size="sm">
                  Go to Reservations
                </Button>
              </Link>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {reservations.map((res) => {
              const tierInfo = getTierDisplay(res.guest);
              const deadlineMs = res.triageDeadline ? new Date(res.triageDeadline).getTime() - nowMs : 0;
              const timer = formatRemaining(deadlineMs);
              const isActioning = actionLoadingId === res.id;
              const hasAllergies = Boolean(res.guest.allergies || res.dietaryRequests);
              const isEscalated = Boolean(res.escalatedAt);

              return (
                <Card
                  key={res.id}
                  className={`relative flex flex-col overflow-hidden transition-all duration-150 ${
                    isEscalated
                      ? 'border-red/40 ring-1 ring-red/20 shadow-md'
                      : 'hover:border-border-strong hover:shadow-sm'
                  }`}
                >
                  {/* Escalated Callout Banner */}
                  {isEscalated ? (
                    <div className="flex items-center gap-2 bg-red-soft px-5 py-2.5 text-xs font-semibold text-red-fg border-b border-red/20">
                      <ShieldAlert size={15} className="shrink-0" />
                      <span>ESCALATED TO MANAGER · Triage timeout exceeded · Action required immediately</span>
                    </div>
                  ) : null}

                  <CardHeader className="items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/admin/${venueId}/guests/${res.guest.id}`}
                          className="text-base font-semibold text-gray-1000 hover:text-accent hover:underline"
                        >
                          {res.guest.name}
                        </Link>
                        <Badge tone={tierInfo.tone}>{tierInfo.label}</Badge>
                        {res.guest.totalVisits > 0 ? (
                          <span className="text-xs text-gray-700">
                            ({res.guest.totalVisits} prior {res.guest.totalVisits === 1 ? 'visit' : 'visits'})
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-800">
                        <span className="inline-flex items-center gap-1 tabular">
                          <Phone size={12} className="text-gray-700" />
                          {res.guest.phone}
                        </span>
                        {res.guest.email ? (
                          <span className="inline-flex items-center gap-1">
                            <Mail size={12} className="text-gray-700" />
                            {res.guest.email}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {/* Deadline Countdown Pill */}
                    <div
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium tabular ${
                        timer.isOverdue
                          ? 'border-red/30 bg-red-soft text-red-fg animate-pulse'
                          : timer.isUrgent
                          ? 'border-amber/30 bg-amber-soft text-amber-fg'
                          : 'border-border bg-background-2 text-gray-900'
                      }`}
                      title={res.triageDeadline ? `Deadline: ${new Date(res.triageDeadline).toLocaleTimeString()}` : undefined}
                    >
                      <Clock size={13} className={timer.isOverdue ? 'text-red' : 'text-gray-800'} />
                      <span>{timer.text}</span>
                    </div>
                  </CardHeader>

                  <CardBody className="space-y-4 flex-1">
                    {/* Booking Details Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-lg border border-border bg-background-2 p-3 text-xs">
                      <div>
                        <span className="text-gray-700 block">Date</span>
                        <span className="font-medium text-gray-1000 inline-flex items-center gap-1 mt-0.5">
                          <Calendar size={13} className="text-gray-800" />
                          {formatDateShort(res.date)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-700 block">Time</span>
                        <span className="font-semibold text-gray-1000 mt-0.5 block tabular">
                          {formatTime12(res.time)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-700 block">Party Size</span>
                        <span className="font-medium text-gray-1000 inline-flex items-center gap-1 mt-0.5">
                          <Users size={13} className="text-gray-800" />
                          {res.partySize} {res.partySize === 1 ? 'Cover' : 'Covers'}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-700 block">Preference</span>
                        <span className="font-medium text-gray-1000 mt-0.5 block">
                          {res.seatingPreference || 'ANY'}
                        </span>
                      </div>
                    </div>

                    {/* Allergies Alert Banner */}
                    {hasAllergies ? (
                      <div className="flex items-start gap-2.5 rounded-lg border border-red/30 bg-red-soft px-3.5 py-2.5 text-xs text-red-fg">
                        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                        <div>
                          <span className="font-bold uppercase tracking-wider block">Dietary & Allergy Alert</span>
                          <span className="font-medium">
                            {[res.guest.allergies, res.dietaryRequests].filter(Boolean).join(' · ')}
                          </span>
                        </div>
                      </div>
                    ) : null}

                    {/* Guest Notes */}
                    {res.notes ? (
                      <div className="rounded-lg border border-border bg-background p-3 text-xs">
                        <span className="text-gray-700 font-medium block mb-1">Guest Note:</span>
                        <p className="text-gray-950 italic whitespace-pre-wrap leading-relaxed">
                          &ldquo;{res.notes}&rdquo;
                        </p>
                      </div>
                    ) : null}

                    {/* Auto Tags & Badges */}
                    {res.guest.tags && res.guest.tags.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        <span className="text-xs text-gray-700 mr-1 flex items-center gap-1">
                          <Sparkles size={12} /> Tags:
                        </span>
                        {res.guest.tags.map((tag) => (
                          <Badge key={tag} tone="neutral" className="text-[11px] h-5 px-2">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </CardBody>

                  <CardFooter className="justify-between border-t border-border bg-background-2 px-5 py-3">
                    <span className="text-xs text-gray-700 tabular">
                      Requested {new Date(res.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={isActioning}
                        onClick={() => {
                          setRejectDialogItem(res);
                          setRejectReason('');
                        }}
                      >
                        <XCircle size={14} className="mr-1 text-red" />
                        Decline
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        loading={isActioning}
                        onClick={() => void handleApprove(res)}
                      >
                        <CheckCircle2 size={14} className="mr-1 text-success" />
                        Approve
                      </Button>
                    </div>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Decline Reason Modal */}
      <Dialog
        open={Boolean(rejectDialogItem)}
        onClose={() => setRejectDialogItem(null)}
        title="Decline Booking Request"
        description={
          rejectDialogItem
            ? `Decline reservation for ${rejectDialogItem.guest.name} (${formatDateShort(rejectDialogItem.date)} at ${formatTime12(rejectDialogItem.time)}).`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setRejectDialogItem(null)} disabled={submittingReject}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" loading={submittingReject} onClick={() => void handleConfirmReject()}>
              Confirm Decline
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="reject-reason">Decline Reason (Optional)</Label>
            <Textarea
              id="reject-reason"
              placeholder="e.g. Fully booked at this seating time, kitchen maintenance, private event..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              maxLength={200}
            />
            <p className="mt-1 text-xs text-gray-700">
              The guest will be notified of the cancellation via SMS/WhatsApp.
            </p>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
