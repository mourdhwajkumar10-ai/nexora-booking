'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Calendar,
  CheckCircle2,
  Clock,
  Filter,
  Plus,
  Search,
  Users,
  Utensils,
  XCircle,
  Armchair,
  UserX,
  PhoneCall,
  Globe,
  Footprints,
  AlertCircle,
  Shuffle,
  RefreshCw,
  X,
} from 'lucide-react';
import type { AdminReservation, DiningTableDto, HostBookingInput } from '@nexora/shared';
import { adminApi, apiMessage, send } from '@/components/admin/admin-api';
import { useConsole } from '@/components/admin/console-provider';
import { formatDateShort, formatTime12, todayIn } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Dialog,
  EmptyState,
  Field,
  Input,
  Label,
  Select,
  Skeleton,
  StatusBadge,
  Switch,
  Textarea,
} from '@/components/ui';

const STATUS_FILTERS = [
  'ALL',
  'REQUESTED',
  'CONFIRMED',
  'SEATED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number];

function getSourceBadge(source: AdminReservation['source']) {
  switch (source) {
    case 'ONLINE':
      return (
        <Badge tone="blue" className="gap-1 text-[11px] h-5 px-2">
          <Globe size={11} /> Online
        </Badge>
      );
    case 'PHONE':
      return (
        <Badge tone="amber" className="gap-1 text-[11px] h-5 px-2">
          <PhoneCall size={11} /> Phone
        </Badge>
      );
    case 'WALK_IN':
      return (
        <Badge tone="neutral" className="gap-1 text-[11px] h-5 px-2">
          <Footprints size={11} /> Walk-in
        </Badge>
      );
    default:
      return <Badge tone="neutral">{source}</Badge>;
  }
}

export default function ReservationsPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = React.use(params);
  const { timezone, subscribe, emit } = useConsole();

  const [date, setDate] = useState(() => todayIn(timezone, 0));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [tables, setTables] = useState<DiningTableDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  // Reassign Modal
  const [reassignItem, setReassignItem] = useState<AdminReservation | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string>('');
  const [submittingReassign, setSubmittingReassign] = useState(false);

  // Reason Modal (for Reject or Cancel)
  const [reasonModalState, setReasonModalState] = useState<{
    reservation: AdminReservation;
    action: 'REJECT' | 'CANCEL';
  } | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [submittingReason, setSubmittingReason] = useState(false);

  // Host Booking Modal
  const [bookingModalOpen, setBookingModalOpen] = useState(false);
  const [submittingBooking, setSubmittingBooking] = useState(false);
  const [bookingForm, setBookingForm] = useState<{
    date: string;
    time: string;
    partySize: number;
    fullName: string;
    phone: string;
    email: string;
    tableId: string;
    autoConfirm: boolean;
    seatingPreference: 'ANY' | 'BOOTH' | 'WINDOW' | 'QUIET' | 'PATIO';
    dietaryRequests: string;
    notes: string;
  }>({
    date: todayIn(timezone, 0),
    time: '19:00',
    partySize: 2,
    fullName: '',
    phone: '',
    email: '',
    tableId: '',
    autoConfirm: true,
    seatingPreference: 'ANY',
    dietaryRequests: '',
    notes: '',
  });

  const loadReservations = useCallback(async () => {
    try {
      const queryParams = new URLSearchParams();
      if (date) queryParams.set('date', date);
      if (statusFilter !== 'ALL') queryParams.set('status', statusFilter);

      const url = `/admin/venues/${venueId}/reservations?${queryParams.toString()}`;
      const data = await adminApi<AdminReservation[]>(url);
      setReservations(data);
    } catch (e) {
      toast.error('Could not load reservations', { description: apiMessage(e) });
    } finally {
      setLoading(false);
    }
  }, [venueId, date, statusFilter]);

  const loadTables = useCallback(async () => {
    try {
      const data = await adminApi<DiningTableDto[]>(`/admin/venues/${venueId}/tables`);
      setTables(data);
    } catch {
      // Ignore
    }
  }, [venueId]);

  useEffect(() => {
    void loadReservations();
    void loadTables();
    return subscribe(['reservation:changed', 'poll'], () => void loadReservations());
  }, [loadReservations, loadTables, subscribe]);

  // Quick Day Options
  const todayStr = useMemo(() => todayIn(timezone, 0), [timezone]);
  const tomorrowStr = useMemo(() => todayIn(timezone, 1), [timezone]);
  const dayAfterTomorrowStr = useMemo(() => todayIn(timezone, 2), [timezone]);

  // Filtered reservations by search
  const filteredReservations = useMemo(() => {
    if (!searchQuery.trim()) return reservations;
    const q = searchQuery.toLowerCase().trim();
    return reservations.filter(
      (r) =>
        r.guest.name.toLowerCase().includes(q) ||
        r.guest.phone.toLowerCase().includes(q) ||
        r.token.toLowerCase().includes(q) ||
        (r.table?.tableNumber && r.table.tableNumber.toLowerCase().includes(q)),
    );
  }, [reservations, searchQuery]);

  // Contextual actions
  const handleSeat = async (res: AdminReservation) => {
    setActionLoadingId(res.id);
    try {
      await send('POST', `/admin/reservations/${res.id}/seat`);
      toast.success(`${res.guest.name} seated`);
      emit('reservation:changed');
      void loadReservations();
    } catch (e) {
      toast.error('Could not seat guest', { description: apiMessage(e) });
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleComplete = async (res: AdminReservation) => {
    setActionLoadingId(res.id);
    try {
      await send('POST', `/admin/reservations/${res.id}/complete`);
      toast.success(`Reservation completed for ${res.guest.name}`);
      emit('reservation:changed');
      void loadReservations();
    } catch (e) {
      toast.error('Could not complete reservation', { description: apiMessage(e) });
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleNoShow = async (res: AdminReservation) => {
    setActionLoadingId(res.id);
    try {
      await send('POST', `/admin/reservations/${res.id}/no-show`);
      toast.warning(`Marked as No-Show: ${res.guest.name}`);
      emit('reservation:changed');
      void loadReservations();
    } catch (e) {
      toast.error('Could not mark no-show', { description: apiMessage(e) });
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleApprove = async (res: AdminReservation) => {
    setActionLoadingId(res.id);
    try {
      await send('POST', `/admin/reservations/${res.id}/approve`);
      toast.success(`Approved reservation for ${res.guest.name}`);
      emit('reservation:changed');
      void loadReservations();
    } catch (e) {
      toast.error('Approval failed', { description: apiMessage(e) });
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleConfirmReason = async () => {
    if (!reasonModalState) return;
    setSubmittingReason(true);
    const { reservation, action } = reasonModalState;
    try {
      const endpoint =
        action === 'REJECT'
          ? `/admin/reservations/${reservation.id}/reject`
          : `/admin/reservations/${reservation.id}/cancel`;

      await send('POST', endpoint, { reason: reasonText.trim() || undefined });
      toast.info(`Reservation ${action === 'REJECT' ? 'declined' : 'cancelled'} for ${reservation.guest.name}`);
      setReasonModalState(null);
      setReasonText('');
      emit('reservation:changed');
      void loadReservations();
    } catch (e) {
      toast.error('Action failed', { description: apiMessage(e) });
    } finally {
      setSubmittingReason(false);
    }
  };

  const handleConfirmReassign = async () => {
    if (!reassignItem || !selectedTableId) return;
    setSubmittingReassign(true);
    try {
      await send('POST', `/admin/reservations/${reassignItem.id}/reassign`, {
        tableId: selectedTableId,
      });
      toast.success(`Table reassigned for ${reassignItem.guest.name}`);
      setReassignItem(null);
      setSelectedTableId('');
      emit('reservation:changed');
      void loadReservations();
    } catch (e) {
      toast.error('Reassignment failed', { description: apiMessage(e) });
    } finally {
      setSubmittingReassign(false);
    }
  };

  const handleCreateHostBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bookingForm.fullName.trim() || !bookingForm.phone.trim()) {
      toast.error('Please enter guest name and phone number');
      return;
    }

    setSubmittingBooking(true);
    try {
      const payload: HostBookingInput = {
        date: bookingForm.date,
        time: bookingForm.time,
        partySize: Number(bookingForm.partySize),
        fullName: bookingForm.fullName.trim(),
        phone: bookingForm.phone.trim(),
        email: bookingForm.email.trim() || undefined,
        tableId: bookingForm.tableId || undefined,
        autoConfirm: bookingForm.autoConfirm,
        source: 'PHONE',
        seatingPreference: bookingForm.seatingPreference,
        dietaryRequests: bookingForm.dietaryRequests.trim() || undefined,
        notes: bookingForm.notes.trim() || undefined,
      };

      await send('POST', `/admin/venues/${venueId}/reservations`, payload);
      toast.success(`Booking created for ${bookingForm.fullName}`, {
        description: `${formatDateShort(bookingForm.date)} at ${formatTime12(bookingForm.time)}`,
      });

      setBookingModalOpen(false);
      // Reset form
      setBookingForm({
        date: date,
        time: '19:00',
        partySize: 2,
        fullName: '',
        phone: '',
        email: '',
        tableId: '',
        autoConfirm: true,
        seatingPreference: 'ANY',
        dietaryRequests: '',
        notes: '',
      });

      emit('reservation:changed');
      void loadReservations();
    } catch (err) {
      toast.error('Could not create booking', { description: apiMessage(err) });
    } finally {
      setSubmittingBooking(false);
    }
  };

  // Suitable tables for reassignment
  const eligibleReassignTables = useMemo(() => {
    if (!reassignItem) return tables;
    return tables.filter((t) => t.maxCapacity >= reassignItem.partySize);
  }, [tables, reassignItem]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Top Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-1000">Reservations</h1>
          <p className="mt-1 text-sm text-gray-800">
            Manage incoming, confirmed, and seated covers. Handle table assignments and take phone bookings.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadReservations()}
            loading={loading}
            className="gap-1.5"
          >
            <RefreshCw size={14} /> Refresh
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setBookingForm((prev) => ({ ...prev, date }));
              setBookingModalOpen(true);
            }}
            className="gap-1.5"
          >
            <Plus size={15} /> New Phone Booking
          </Button>
        </div>
      </div>

      {/* Date & Search Toolbar */}
      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-border bg-background p-4 shadow-sm">
        {/* Quick Date Selectors */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-gray-700 mr-1 flex items-center gap-1">
            <Calendar size={13} /> Day:
          </span>
          <Button
            variant={date === todayStr ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setDate(todayStr)}
            className="h-8 px-2.5 text-xs"
          >
            Today
          </Button>
          <Button
            variant={date === tomorrowStr ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setDate(tomorrowStr)}
            className="h-8 px-2.5 text-xs"
          >
            Tomorrow
          </Button>
          <Button
            variant={date === dayAfterTomorrowStr ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setDate(dayAfterTomorrowStr)}
            className="h-8 px-2.5 text-xs"
          >
            In 2 Days
          </Button>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2.5 text-xs text-gray-1000 transition-colors hover:border-border-strong focus:outline-none focus:ring-1 focus:ring-gray-1000"
          />
        </div>

        {/* Search Input */}
        <div className="relative w-full sm:w-72">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-700" />
          <Input
            type="search"
            placeholder="Search guest, phone, token, table..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-700 hover:text-gray-1000"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Status Segmented Tabs */}
      <div className="mt-4 flex overflow-x-auto pb-1 scrollbar-none">
        <div className="inline-flex rounded-lg border border-border bg-background-2 p-0.5 text-xs font-medium">
          {STATUS_FILTERS.map((st) => {
            const count =
              st === 'ALL'
                ? reservations.length
                : reservations.filter((r) => r.status === st).length;
            const active = statusFilter === st;

            return (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 transition-colors ${
                  active
                    ? 'bg-background text-gray-1000 shadow-sm ring-1 ring-border font-semibold'
                    : 'text-gray-800 hover:text-gray-1000'
                }`}
              >
                <span>{st === 'ALL' ? 'All' : st.replace('_', ' ')}</span>
                <span
                  className={`rounded-full px-1.5 py-0.2 text-[10px] tabular ${
                    active ? 'bg-gray-200 text-gray-1000' : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Table / List View */}
      <div className="mt-6">
        {loading && reservations.length === 0 ? (
          <Card className="p-6">
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-center justify-between border-b border-border pb-4">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-28" />
                  </div>
                  <Skeleton className="h-8 w-24" />
                </div>
              ))}
            </div>
          </Card>
        ) : filteredReservations.length === 0 ? (
          <EmptyState
            icon={<Filter size={36} className="text-gray-700" />}
            title="No reservations found"
            description={
              searchQuery
                ? `No reservations match "${searchQuery}" for ${formatDateShort(date)}.`
                : `No ${statusFilter === 'ALL' ? '' : statusFilter.toLowerCase()} reservations recorded for ${formatDateShort(date)}.`
            }
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setStatusFilter('ALL');
                  setSearchQuery('');
                }}
              >
                Clear Filters
              </Button>
            }
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-background-2 text-gray-800 font-medium">
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">Party</th>
                    <th className="px-4 py-3">Guest</th>
                    <th className="px-4 py-3">Table</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredReservations.map((res) => {
                    const isActioning = actionLoadingId === res.id;
                    const hasDietary = Boolean(res.guest.allergies || res.dietaryRequests || res.notes);

                    return (
                      <tr key={res.id} className="hover:bg-background-2/60 transition-colors">
                        {/* Time */}
                        <td className="whitespace-nowrap px-4 py-3.5">
                          <span className="font-semibold text-gray-1000 tabular block">
                            {formatTime12(res.time)}
                          </span>
                          <span className="text-[11px] text-gray-700 tabular">
                            {res.token}
                          </span>
                        </td>

                        {/* Party Size */}
                        <td className="whitespace-nowrap px-4 py-3.5">
                          <span className="inline-flex items-center gap-1 font-medium text-gray-1000">
                            <Users size={13} className="text-gray-700" />
                            {res.partySize}
                          </span>
                          {res.seatingPreference && res.seatingPreference !== 'ANY' ? (
                            <span className="block text-[10px] text-gray-700">
                              {res.seatingPreference}
                            </span>
                          ) : null}
                        </td>

                        {/* Guest */}
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2">
                            <Link
                              href={`/admin/${venueId}/guests/${res.guest.id}`}
                              className="font-medium text-gray-1000 hover:text-accent hover:underline"
                            >
                              {res.guest.name}
                            </Link>
                            {res.guest.tier && res.guest.tier !== 'BASE' ? (
                              <Badge tone="amber" className="h-4 px-1.5 text-[10px]">
                                {res.guest.tier}
                              </Badge>
                            ) : null}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-gray-700 tabular">
                            <span>{res.guest.phone}</span>
                            {hasDietary ? (
                              <span
                                className="inline-flex items-center gap-0.5 text-amber-fg font-semibold cursor-help"
                                title={[res.guest.allergies, res.dietaryRequests, res.notes].filter(Boolean).join(' · ')}
                              >
                                <AlertCircle size={12} /> Notes
                              </span>
                            ) : null}
                          </div>
                        </td>

                        {/* Assigned Table */}
                        <td className="whitespace-nowrap px-4 py-3.5">
                          {res.table ? (
                            <div className="inline-flex items-center gap-1 font-medium text-gray-1000">
                              <Armchair size={13} className="text-gray-700" />
                              <span>Table {res.table.tableNumber}</span>
                              <span className="text-[10px] text-gray-700">({res.table.maxCapacity}-top)</span>
                            </div>
                          ) : (
                            <span className="text-gray-700 italic">Unassigned</span>
                          )}
                        </td>

                        {/* Status */}
                        <td className="whitespace-nowrap px-4 py-3.5">
                          <StatusBadge status={res.status} />
                        </td>

                        {/* Source */}
                        <td className="whitespace-nowrap px-4 py-3.5">
                          {getSourceBadge(res.source)}
                        </td>

                        {/* Actions */}
                        <td className="whitespace-nowrap px-4 py-3.5 text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            {/* Contextual actions for CONFIRMED */}
                            {res.status === 'CONFIRMED' ? (
                              <>
                                <Button
                                  variant="primary"
                                  size="sm"
                                  className="h-7 px-2.5 text-xs"
                                  loading={isActioning}
                                  onClick={() => void handleSeat(res)}
                                >
                                  <Utensils size={12} className="mr-1 text-success" /> Seat
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  disabled={isActioning}
                                  onClick={() => {
                                    setReassignItem(res);
                                    setSelectedTableId(res.table?.id ?? '');
                                  }}
                                  title="Reassign Table"
                                >
                                  <Shuffle size={12} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-amber-fg hover:bg-amber-soft"
                                  disabled={isActioning}
                                  onClick={() => void handleNoShow(res)}
                                  title="Mark No-Show"
                                >
                                  <UserX size={12} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-red hover:bg-red-soft"
                                  disabled={isActioning}
                                  onClick={() => {
                                    setReasonModalState({ reservation: res, action: 'CANCEL' });
                                    setReasonText('');
                                  }}
                                  title="Cancel Booking"
                                >
                                  <XCircle size={12} />
                                </Button>
                              </>
                            ) : null}

                            {/* Contextual actions for SEATED */}
                            {res.status === 'SEATED' ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                className="h-7 px-2.5 text-xs"
                                loading={isActioning}
                                onClick={() => void handleComplete(res)}
                              >
                                <CheckCircle2 size={12} className="mr-1 text-success" /> Complete
                              </Button>
                            ) : null}

                            {/* Contextual actions for REQUESTED */}
                            {res.status === 'REQUESTED' ? (
                              <>
                                <Button
                                  variant="primary"
                                  size="sm"
                                  className="h-7 px-2.5 text-xs"
                                  loading={isActioning}
                                  onClick={() => void handleApprove(res)}
                                >
                                  Approve
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-red"
                                  disabled={isActioning}
                                  onClick={() => {
                                    setReasonModalState({ reservation: res, action: 'REJECT' });
                                    setReasonText('');
                                  }}
                                >
                                  Reject
                                </Button>
                              </>
                            ) : null}

                            {/* CANCELLED, NO_SHOW, COMPLETED */}
                            {['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(res.status) ? (
                              <span className="text-[11px] text-gray-700 italic">
                                {res.cancelReason ? `Reason: ${res.cancelReason}` : 'Closed'}
                              </span>
                            ) : null}
                          </div>
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

      {/* Host Booking Modal */}
      <Dialog
        open={bookingModalOpen}
        onClose={() => setBookingModalOpen(false)}
        title="New Phone Booking"
        description="Book a table on behalf of a phone caller. Automatically confirms and reserves inventory."
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setBookingModalOpen(false)}
              disabled={submittingBooking}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submittingBooking}
              onClick={(e) => void handleCreateHostBooking(e)}
            >
              Confirm Booking
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => void handleCreateHostBooking(e)} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Booking Date" htmlFor="host-date">
              <Input
                id="host-date"
                type="date"
                required
                value={bookingForm.date}
                onChange={(e) => setBookingForm((p) => ({ ...p, date: e.target.value }))}
              />
            </Field>

            <Field label="Time (15m step)" htmlFor="host-time">
              <Input
                id="host-time"
                type="time"
                step="900"
                required
                value={bookingForm.time}
                onChange={(e) => setBookingForm((p) => ({ ...p, time: e.target.value }))}
              />
            </Field>

            <Field label="Party Size" htmlFor="host-party">
              <Select
                id="host-party"
                value={bookingForm.partySize}
                onChange={(e) => setBookingForm((p) => ({ ...p, partySize: Number(e.target.value) }))}
              >
                <option value={1}>1 Guest</option>
                <option value={2}>2 Guests</option>
                <option value={3}>3 Guests</option>
                <option value={4}>4 Guests</option>
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Guest Full Name" htmlFor="host-name">
              <Input
                id="host-name"
                placeholder="e.g. Vikram Sharma"
                required
                value={bookingForm.fullName}
                onChange={(e) => setBookingForm((p) => ({ ...p, fullName: e.target.value }))}
              />
            </Field>

            <Field label="Phone Number" htmlFor="host-phone">
              <Input
                id="host-phone"
                placeholder="+919876543210"
                required
                value={bookingForm.phone}
                onChange={(e) => setBookingForm((p) => ({ ...p, phone: e.target.value }))}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Email Address (Optional)" htmlFor="host-email">
              <Input
                id="host-email"
                type="email"
                placeholder="guest@example.com"
                value={bookingForm.email}
                onChange={(e) => setBookingForm((p) => ({ ...p, email: e.target.value }))}
              />
            </Field>

            <Field label="Assign Specific Table (Optional)" htmlFor="host-table">
              <Select
                id="host-table"
                value={bookingForm.tableId}
                onChange={(e) => setBookingForm((p) => ({ ...p, tableId: e.target.value }))}
              >
                <option value="">Auto-Assign Best Fit</option>
                {tables
                  .filter((t) => t.maxCapacity >= bookingForm.partySize)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      Table {t.tableNumber} ({t.diningZone}, {t.maxCapacity}-top)
                    </option>
                  ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Seating Preference" htmlFor="host-pref">
              <Select
                id="host-pref"
                value={bookingForm.seatingPreference}
                onChange={(e) =>
                  setBookingForm((p) => ({
                    ...p,
                    seatingPreference: e.target.value as any,
                  }))
                }
              >
                <option value="ANY">No Preference</option>
                <option value="WINDOW">Window</option>
                <option value="BOOTH">Booth</option>
                <option value="QUIET">Quiet Corner</option>
                <option value="PATIO">Patio / Outdoor</option>
              </Select>
            </Field>

            <div className="flex flex-col justify-center pt-5">
              <div className="flex items-center gap-3">
                <Switch
                  id="host-autoconfirm"
                  checked={bookingForm.autoConfirm}
                  onChange={(v) => setBookingForm((p) => ({ ...p, autoConfirm: v }))}
                />
                <Label htmlFor="host-autoconfirm" className="mb-0 cursor-pointer">
                  Auto-Confirm (Skip Triage)
                </Label>
              </div>
              <p className="mt-1 text-xs text-gray-700">
                Immediately issues booking confirmation SMS/WhatsApp.
              </p>
            </div>
          </div>

          <Field label="Dietary Requests or Allergies (Optional)" htmlFor="host-dietary">
            <Input
              id="host-dietary"
              placeholder="e.g. Nut allergy, Gluten-free, Jain"
              value={bookingForm.dietaryRequests}
              onChange={(e) => setBookingForm((p) => ({ ...p, dietaryRequests: e.target.value }))}
            />
          </Field>

          <Field label="Host Notes / Occasion (Optional)" htmlFor="host-notes">
            <Textarea
              id="host-notes"
              placeholder="e.g. Anniversary celebration, requests champagne on arrival"
              rows={2}
              value={bookingForm.notes}
              onChange={(e) => setBookingForm((p) => ({ ...p, notes: e.target.value }))}
            />
          </Field>
        </form>
      </Dialog>

      {/* Reassign Table Modal */}
      <Dialog
        open={Boolean(reassignItem)}
        onClose={() => setReassignItem(null)}
        title="Reassign Table"
        description={
          reassignItem
            ? `Select an alternate table for ${reassignItem.guest.name} (Party of ${reassignItem.partySize}).`
            : undefined
        }
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReassignItem(null)}
              disabled={submittingReassign}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submittingReassign}
              disabled={!selectedTableId}
              onClick={() => void handleConfirmReassign()}
            >
              Reassign Table
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Select Table" htmlFor="reassign-select">
            <Select
              id="reassign-select"
              value={selectedTableId}
              onChange={(e) => setSelectedTableId(e.target.value)}
            >
              <option value="" disabled>
                -- Choose a dining table --
              </option>
              {eligibleReassignTables.map((t) => (
                <option key={t.id} value={t.id}>
                  Table {t.tableNumber} · {t.diningZone} ({t.minCapacity}-{t.maxCapacity} covers) · {t.status}
                </option>
              ))}
            </Select>
          </Field>
          <p className="text-xs text-gray-700">
            Only tables matching party size capacity are displayed. Reassigning will swap reservation schedules atomically.
          </p>
        </div>
      </Dialog>

      {/* Reject / Cancel Reason Modal */}
      <Dialog
        open={Boolean(reasonModalState)}
        onClose={() => setReasonModalState(null)}
        title={reasonModalState?.action === 'REJECT' ? 'Decline Reservation' : 'Cancel Reservation'}
        description={
          reasonModalState
            ? `${reasonModalState.action === 'REJECT' ? 'Reject request' : 'Cancel booking'} for ${
                reasonModalState.reservation.guest.name
              }.`
            : undefined
        }
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReasonModalState(null)}
              disabled={submittingReason}
            >
              Back
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={submittingReason}
              onClick={() => void handleConfirmReason()}
            >
              Confirm {reasonModalState?.action === 'REJECT' ? 'Decline' : 'Cancellation'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Reason (Optional)" htmlFor="action-reason">
            <Textarea
              id="action-reason"
              placeholder="e.g. Guest requested cancellation by phone, overbooking..."
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              rows={3}
              maxLength={200}
            />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
