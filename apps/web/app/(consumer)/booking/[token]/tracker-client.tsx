'use client';

import { useEffect, useState, useTransition } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {
  Calendar,
  Clock,
  MapPin,
  Users,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Download,
  UtensilsCrossed,
  Phone,
  Radio,
  ArrowRight,
} from 'lucide-react';
import type { PublicReservation, ReservationStatus } from '@nexora/shared';
import { api, ApiRequestError, errorMessage } from '@/lib/api';
import { formatDateShort, formatTime12 } from '@/lib/format';
import { getSocket } from '@/lib/socket';
import { cn } from '@/lib/cn';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { icsDataUrl, isOptimizableImage } from '@/components/consumer/utils';

const STANDARD_STEPS = [
  { status: 'REQUESTED', title: 'Request submitted', subtitle: 'Awaiting host confirmation', isWarning: false },
  { status: 'CONFIRMED', title: 'Confirmed', subtitle: 'Table held for your party', isWarning: false },
  { status: 'ARRIVED', title: 'Arrived', subtitle: 'Checked in with the host desk', isWarning: false },
  { status: 'SEATED', title: 'Seated', subtitle: 'Welcome to your table', isWarning: false },
  { status: 'COMPLETED', title: 'Completed', subtitle: 'Hope you enjoyed your visit', isWarning: false },
];

const LATE_STEPS = [
  { status: 'REQUESTED', title: 'Request submitted', subtitle: 'Awaiting host confirmation', isWarning: false },
  { status: 'CONFIRMED', title: 'Confirmed', subtitle: 'Reservation held', isWarning: false },
  { status: 'LATE', title: 'Running Late', subtitle: '15m grace window active', isWarning: true },
  { status: 'ARRIVED', title: 'Arrived', subtitle: 'Checked in with host desk', isWarning: false },
  { status: 'SEATED', title: 'Seated', subtitle: 'Welcome to your table', isWarning: false },
  { status: 'COMPLETED', title: 'Completed', subtitle: 'Hope you enjoyed your visit', isWarning: false },
];

const STATUS_PILL_CONFIG: Record<
  string,
  { label: string; tone: BadgeTone; description: string }
> = {
  REQUESTED: {
    label: 'Awaiting Confirmation',
    tone: 'amber',
    description: 'The restaurant host has received your request and will review it shortly.',
  },
  CONFIRMED: {
    label: 'Confirmed',
    tone: 'green',
    description: 'Your table has been reserved. Please arrive on time.',
  },
  ARRIVED: {
    label: 'Arrived at Desk',
    tone: 'blue',
    description: 'You have checked in at the restaurant. Your table is being readied.',
  },
  LATE: {
    label: 'Running Late',
    tone: 'amber',
    description: 'We notice your party is running late. Your table is being held during our grace window.',
  },
  SEATED: {
    label: 'Seated',
    tone: 'blue',
    description: 'You are seated. Enjoy your dining experience!',
  },
  COMPLETED: {
    label: 'Completed',
    tone: 'neutral',
    description: 'Thank you for dining with us. We look forward to seeing you again.',
  },
  CANCELLED: {
    label: 'Cancelled',
    tone: 'red',
    description: 'This booking has been cancelled.',
  },
  NO_SHOW: {
    label: 'Marked No-Show',
    tone: 'red',
    description: 'This booking was marked as a no-show.',
  },
};

export function BookingTrackerClient({
  token,
  initialReservation,
}: {
  token: string;
  initialReservation: PublicReservation;
}) {
  const [reservation, setReservation] = useState<PublicReservation>(initialReservation);
  const [socketConnected, setSocketConnected] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [phoneLast4, setPhoneLast4] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelPending, startCancelTransition] = useTransition();
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleGuestArrive = async () => {
    setActionLoading('arrive');
    try {
      const updated = await api<PublicReservation>(`/reservations/${token}/arrive`, { method: 'POST' });
      setReservation(updated);
      toast.success('Welcome! You have checked in at the restaurant.');
    } catch (err) {
      toast.error('Check-in failed', { description: errorMessage(err) });
    } finally {
      setActionLoading(null);
    }
  };

  const handleGuestLate = async () => {
    setActionLoading('late');
    try {
      const updated = await api<PublicReservation>(`/reservations/${token}/late`, { method: 'POST' });
      setReservation(updated);
      toast.warning('Host notified that you are running late. Your table is held.');
    } catch (err) {
      toast.error('Could not notify host', { description: errorMessage(err) });
    } finally {
      setActionLoading(null);
    }
  };

  const currentStatus = reservation.status;
  const isCancelledOrDeclined = currentStatus === 'CANCELLED' || currentStatus === 'NO_SHOW';
  const canCancel = currentStatus === 'REQUESTED' || currentStatus === 'CONFIRMED' || currentStatus === 'LATE';

  const isLate = currentStatus === 'LATE';
  const steps = isLate ? LATE_STEPS : STANDARD_STEPS;
  const orderMap: Record<string, number> = isLate
    ? { REQUESTED: 0, CONFIRMED: 1, LATE: 2, ARRIVED: 3, SEATED: 4, COMPLETED: 5, CANCELLED: -1, NO_SHOW: -1 }
    : { REQUESTED: 0, CONFIRMED: 1, ARRIVED: 2, SEATED: 3, COMPLETED: 4, CANCELLED: -1, NO_SHOW: -1 };
  const currentIndex = orderMap[currentStatus] ?? -1;

  // Real-time updates via Socket.IO + Polling Fallback (10s)
  useEffect(() => {
    let mounted = true;
    const socket = getSocket();

    const joinRoom = () => {
      socket.emit('booking:join', token);
    };

    if (socket.connected) {
      setSocketConnected(true);
      joinRoom();
    }

    const onConnect = () => {
      if (!mounted) return;
      setSocketConnected(true);
      joinRoom();
    };

    const onDisconnect = () => {
      if (!mounted) return;
      setSocketConnected(false);
    };

    const onStatusUpdate = (payload: {
      token: string;
      status: ReservationStatus;
      tableNumber: string | null;
      serverTime: string;
    }) => {
      if (!mounted || payload.token !== token) return;
      setReservation((prev) => ({
        ...prev,
        status: payload.status,
        tableNumber: payload.tableNumber,
      }));

      // Background re-fetch to sync any newly set timestamps (confirmedAt, cancelledAt, cancelReason)
      api<PublicReservation>(`/reservations/${token}`)
        .then((fresh) => {
          if (mounted && fresh) setReservation(fresh);
        })
        .catch(() => {});
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('booking:status', onStatusUpdate);

    // 10-second polling fallback
    const pollInterval = setInterval(async () => {
      try {
        const fresh = await api<PublicReservation>(`/reservations/${token}`);
        if (mounted && fresh) {
          setReservation(fresh);
        }
      } catch {
        // Soft error: keep current state during temporary connection interruption
      }
    }, 10_000);

    return () => {
      mounted = false;
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('booking:status', onStatusUpdate);
      clearInterval(pollInterval);
    };
  }, [token]);

  // Handle Cancel Submission
  const handleCancelSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{4}$/.test(phoneLast4.trim())) {
      setCancelError('Please enter exactly 4 digits');
      return;
    }

    setCancelError(null);
    startCancelTransition(async () => {
      try {
        const updated = await api<PublicReservation>(`/reservations/${token}/cancel`, {
          method: 'POST',
          json: { phoneLast4: phoneLast4.trim() },
        });
        setReservation(updated);
        setCancelModalOpen(false);
        setPhoneLast4('');
      } catch (err) {
        if (err instanceof ApiRequestError) {
          if (err.code === 'PHONE_MISMATCH') {
            setCancelError('The last 4 digits do not match the phone number for this booking');
            return;
          }
          if (err.code === 'ILLEGAL_TRANSITION') {
            setCancelError('This booking can no longer be cancelled.');
            return;
          }
          setCancelError(err.message);
          return;
        }
        setCancelError(errorMessage(err));
      }
    });
  };

  const statusConfig = STATUS_PILL_CONFIG[currentStatus] ?? {
    label: currentStatus,
    tone: 'neutral',
    description: '',
  };

  // Calendar Event link
  const calendarUrl = icsDataUrl({
    uid: reservation.token,
    title: `Reservation at ${reservation.venue.name}`,
    start: reservation.startAt,
    end: reservation.endAt,
    location: `${reservation.venue.name}, ${reservation.venue.address}`,
    description: `Reservation for ${reservation.partySize} ${reservation.partySize === 1 ? 'guest' : 'guests'} under ${reservation.guestName}. Reference: ${reservation.token.slice(0, 8)}`,
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      {/* Live sync banner */}
      <div className="mb-6 flex items-center justify-between text-xs text-gray-800">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2">
            <span
              className={cn(
                'absolute inline-flex size-full rounded-full opacity-75',
                socketConnected ? 'animate-ping bg-success' : 'bg-amber'
              )}
            />
            <span
              className={cn(
                'relative inline-flex size-2 rounded-full',
                socketConnected ? 'bg-success' : 'bg-amber'
              )}
            />
          </span>
          <span className="font-mono uppercase tracking-wider text-[11px]">
            {socketConnected ? 'Live Connection Active' : 'Connecting live stream…'}
          </span>
        </div>
        <span className="font-mono text-gray-700">Ref: {reservation.token.slice(0, 8)}</span>
      </div>

      {/* Main Status Header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-gray-1000">
              Booking Status
            </h1>
            <Badge tone={statusConfig.tone} dot className="text-[13px] py-1 px-3">
              {statusConfig.label}
            </Badge>
          </div>
          <p className="mt-1.5 text-sm text-gray-900">{statusConfig.description}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start sm:self-center">
          {currentStatus === 'CONFIRMED' && (
            <>
              <Button
                variant="secondary"
                size="sm"
                loading={actionLoading === 'late'}
                onClick={handleGuestLate}
                className="text-amber-fg hover:border-amber/40 hover:bg-amber-soft text-xs"
                title="Notify host you are running up to 15 minutes late"
              >
                <Clock size={13} className="mr-1" />
                Running Late (+15m)
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={actionLoading === 'arrive'}
                onClick={handleGuestArrive}
                className="text-xs"
                title="Contactless arrival check-in"
              >
                <CheckCircle2 size={13} className="mr-1" />
                Check In (I'm Here)
              </Button>
            </>
          )}

          {currentStatus === 'LATE' && (
            <Button
              variant="primary"
              size="sm"
              loading={actionLoading === 'arrive'}
              onClick={handleGuestArrive}
              className="bg-amber-fg hover:bg-amber-fg/90 text-white text-xs"
              title="Check in at the host desk now"
            >
              <CheckCircle2 size={13} className="mr-1" />
              Check In (I'm Here)
            </Button>
          )}

          {canCancel && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setCancelError(null);
                setPhoneLast4('');
                setCancelModalOpen(true);
              }}
              className="text-red-fg hover:border-red/40 hover:bg-red-soft sm:self-center text-xs"
            >
              Cancel reservation
            </Button>
          )}
        </div>
      </div>

      {/* Cancelled / Declined Alert Banner */}
      {isCancelledOrDeclined && (
        <div className="mb-8 rounded-xl border border-red/20 bg-red-soft p-5 text-gray-1000">
          <div className="flex items-start gap-3">
            <XCircle className="mt-0.5 size-5 shrink-0 text-red-fg" />
            <div className="flex-1">
              <h2 className="text-[15px] font-semibold text-red-fg">
                {reservation.cancelReason?.toLowerCase().includes('decline') ||
                reservation.cancelReason?.toLowerCase().includes('reject')
                  ? 'Reservation Declined by Restaurant'
                  : currentStatus === 'NO_SHOW'
                  ? 'Booking Marked as No-Show'
                  : 'Reservation Cancelled'}
              </h2>
              <p className="mt-1 text-sm text-red-fg/90">
                {reservation.cancelReason ||
                  'This reservation has been cancelled and table inventory released.'}
              </p>
              <div className="mt-4">
                <Link
                  href={`/r/${reservation.venue.slug}`}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-gray-1000 px-4 text-xs font-medium text-white transition-colors duration-150 hover:bg-[#383838]"
                >
                  Pick another time
                  <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Running Late Grace Period Banner */}
      {currentStatus === 'LATE' && (
        <div className="mb-8 rounded-xl border border-amber/30 bg-amber-soft/20 p-5 text-gray-1000">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-amber-fg" />
            <div className="flex-1">
              <h2 className="text-[15px] font-semibold text-amber-fg">
                Grace Period Active (15 Minutes)
              </h2>
              <p className="mt-1 text-sm text-gray-900">
                You are marked as running late. The restaurant is holding your table during our grace period. When you arrive, tap the button below or let the host desk know.
              </p>
              <div className="mt-4 flex gap-3">
                <Button
                  variant="primary"
                  size="sm"
                  loading={actionLoading === 'arrive'}
                  onClick={handleGuestArrive}
                  className="bg-amber-fg hover:bg-amber-fg/90 text-white text-xs"
                >
                  <CheckCircle2 size={14} className="mr-1.5" />
                  I Have Arrived at the Restaurant
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Status Timeline */}
      {!isCancelledOrDeclined && (
        <Card className="mb-8 border-border bg-background p-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-800">
            Progress Timeline
          </h2>
          <div
            className={cn(
              'mt-6 grid grid-cols-1 gap-4',
              isLate ? 'sm:grid-cols-6' : 'sm:grid-cols-5',
            )}
          >
            {steps.map((step, idx) => {
              const isPast = currentIndex > idx;
              const isCurrent = currentIndex === idx;
              const isFuture = currentIndex < idx;

              return (
                <div key={step.status} className="relative flex flex-col items-start sm:items-center text-left sm:text-center">
                  {/* Step Connector Line */}
                  {idx < steps.length - 1 && (
                    <div
                      aria-hidden
                      className={cn(
                        'hidden sm:block absolute top-4 left-1/2 w-full h-[2px] -z-0',
                        isPast ? 'bg-success' : 'bg-gray-200'
                      )}
                    />
                  )}

                  {/* Step Circle Indicator */}
                  <div
                    className={cn(
                      'relative z-10 flex size-8 items-center justify-center rounded-full text-xs font-semibold transition-all duration-200',
                      step.isWarning && isCurrent && 'bg-amber text-white ring-4 ring-amber-soft animate-alert-pulse',
                      !step.isWarning && isPast && 'bg-success text-white ring-4 ring-success-soft',
                      !step.isWarning && isCurrent && 'bg-gray-1000 text-white ring-4 ring-gray-100',
                      isFuture && 'bg-gray-100 text-gray-700 border border-border'
                    )}
                  >
                    {step.isWarning && isCurrent ? (
                      <AlertCircle size={16} />
                    ) : isPast ? (
                      <CheckCircle2 size={16} />
                    ) : (
                      <span>{idx + 1}</span>
                    )}
                  </div>

                  {/* Step Texts */}
                  <div className="mt-3">
                    <p
                      className={cn(
                        'text-xs font-semibold tracking-tight',
                        step.isWarning && isCurrent
                          ? 'text-amber-fg font-bold'
                          : isCurrent
                          ? 'text-gray-1000'
                          : isPast
                          ? 'text-gray-900'
                          : 'text-gray-700'
                      )}
                    >
                      {step.title}
                    </p>
                    <p className="mt-0.5 text-[11px] text-gray-800 leading-tight">
                      {step.subtitle}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Table Number Reveal Card */}
      <Card className="mb-8 border-border bg-background overflow-hidden">
        <div className="flex flex-col items-start justify-between gap-4 p-5 sm:flex-row sm:items-center bg-background-2 border-b border-border">
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-gray-800">
              Seating Allocation
            </span>
            <div className="mt-1 flex items-center gap-2">
              <UtensilsCrossed size={16} className="text-gray-700" />
              <span className="text-sm font-semibold text-gray-1000">
                Dining Room Placement
              </span>
            </div>
          </div>

          <div>
            {currentStatus === 'CONFIRMED' || currentStatus === 'SEATED' ? (
              <div className="inline-flex items-center gap-2 rounded-lg border border-success/30 bg-success-soft px-3 py-1.5 text-success-fg">
                <span className="size-2 rounded-full bg-success" />
                <span className="text-sm font-semibold tracking-tight tabular-nums">
                  {reservation.tableNumber ? `Table ${reservation.tableNumber}` : 'Table Assigned'}
                </span>
              </div>
            ) : currentStatus === 'REQUESTED' ? (
              <div className="inline-flex items-center gap-2 rounded-lg border border-amber/25 bg-amber-soft px-3 py-1.5 text-amber-fg">
                <Clock size={14} />
                <span className="text-xs font-medium">
                  Table will be assigned upon confirmation
                </span>
              </div>
            ) : (
              <span className="text-xs text-gray-800">No active table allocation</span>
            )}
          </div>
        </div>
      </Card>

      {/* Reservation Details Card */}
      <Card className="border-border bg-background shadow-sm">
        <CardHeader className="flex-row items-center justify-between pb-4">
          <div>
            <CardTitle className="text-base">Reservation Details</CardTitle>
            <p className="text-xs text-gray-800">Review your venue and guest information</p>
          </div>
          {!isCancelledOrDeclined && (
            <a
              href={calendarUrl}
              download={`reservation-${reservation.token.slice(0, 8)}.ics`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-gray-900 transition-colors hover:bg-background-2 hover:text-gray-1000"
            >
              <Download size={13} />
              Add to Calendar
            </a>
          )}
        </CardHeader>

        <CardBody className="pt-2">
          {/* Venue Info Row */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center border-b border-border pb-6">
            <div className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-border bg-gray-100">
              <Image
                src={reservation.venue.imageUrl}
                alt={reservation.venue.name}
                fill
                sizes="64px"
                className="object-cover"
                unoptimized={!isOptimizableImage(reservation.venue.imageUrl)}
              />
            </div>
            <div className="flex-1">
              <h3 className="text-base font-semibold text-gray-1000">
                <Link
                  href={`/r/${reservation.venue.slug}`}
                  className="hover:underline hover:text-accent"
                >
                  {reservation.venue.name}
                </Link>
              </h3>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-800">
                <MapPin size={12} className="shrink-0 text-gray-700" />
                <span>
                  {reservation.venue.address}, {reservation.venue.localityLabel}
                </span>
              </p>
            </div>
          </div>

          {/* Booking Key Metrics Grid */}
          <div className="grid grid-cols-1 gap-4 py-6 sm:grid-cols-2 md:grid-cols-4 border-b border-border">
            <div className="flex items-start gap-3">
              <div className="rounded-md border border-border bg-background-2 p-2 text-gray-800">
                <Calendar size={16} />
              </div>
              <div>
                <p className="text-xs text-gray-800 font-medium">Date</p>
                <p className="text-sm font-semibold text-gray-1000 tabular-nums">
                  {formatDateShort(reservation.date)}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="rounded-md border border-border bg-background-2 p-2 text-gray-800">
                <Clock size={16} />
              </div>
              <div>
                <p className="text-xs text-gray-800 font-medium">Time</p>
                <p className="text-sm font-semibold text-gray-1000 tabular-nums">
                  {formatTime12(reservation.time)}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="rounded-md border border-border bg-background-2 p-2 text-gray-800">
                <Users size={16} />
              </div>
              <div>
                <p className="text-xs text-gray-800 font-medium">Party Size</p>
                <p className="text-sm font-semibold text-gray-1000 tabular-nums">
                  Party of {reservation.partySize}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="rounded-md border border-border bg-background-2 p-2 text-gray-800">
                <Phone size={16} />
              </div>
              <div>
                <p className="text-xs text-gray-800 font-medium">Contact</p>
                <p className="text-sm font-semibold text-gray-1000 tabular-nums">
                  {reservation.phoneMasked}
                </p>
              </div>
            </div>
          </div>

          {/* Guest Name & Notes Footer */}
          <div className="pt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-xs text-gray-900">
            <div>
              <span className="text-gray-800">Primary Diner: </span>
              <span className="font-semibold text-gray-1000">{reservation.guestName}</span>
            </div>
            <div className="font-mono text-gray-700">
              Created {formatDateShort(reservation.createdAt.slice(0, 10))} at {reservation.time}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Cancel Booking Dialog Modal */}
      <Dialog
        open={cancelModalOpen}
        onClose={() => {
          if (!cancelPending) {
            setCancelModalOpen(false);
            setCancelError(null);
          }
        }}
        title="Cancel reservation"
        description="To protect your booking from unauthorized changes, please verify the last 4 digits of the phone number used when booking."
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={cancelPending}
              onClick={() => {
                setCancelModalOpen(false);
                setCancelError(null);
              }}
            >
              Keep reservation
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={cancelPending}
              onClick={handleCancelSubmit}
            >
              Confirm cancellation
            </Button>
          </div>
        }
      >
        <form onSubmit={handleCancelSubmit} className="space-y-4">
          <div>
            <Label htmlFor="cancel-phone-last4" className="text-xs font-medium">
              Last 4 digits of phone number
            </Label>
            <div className="relative mt-1">
              <Input
                id="cancel-phone-last4"
                name="phoneLast4"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                autoFocus
                placeholder="e.g. 3210"
                value={phoneLast4}
                onChange={(e) => {
                  setPhoneLast4(e.target.value.replace(/\D/g, '').slice(0, 4));
                  if (cancelError) setCancelError(null);
                }}
                className="font-mono text-base tracking-widest tabular-nums text-center"
              />
            </div>
            {cancelError ? (
              <p role="alert" className="mt-2 text-xs font-medium text-red-fg">
                {cancelError}
              </p>
            ) : (
              <p className="mt-1.5 text-xs text-gray-800">
                Must match the last 4 digits of {reservation.phoneMasked}
              </p>
            )}
          </div>
        </form>
      </Dialog>
    </div>
  );
}
