'use client';

import { useState } from 'react';
import type { FloorTable } from '@nexora/shared';
import { formatElapsed, formatINR, formatMoney, timerState } from '@nexora/shared';
import { useServerNow } from '../clock';
import { useConsole } from '../console-provider';
import { send, apiMessage } from '../admin-api';
import { Badge, Button, Card, StatusBadge } from '@/components/ui';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Armchair,
  CheckCircle2,
  Clock,
  MoreVertical,
  Receipt,
  Sparkles,
  Unlock,
  UserCheck,
  UserPlus,
  Users,
  UtensilsCrossed,
} from 'lucide-react';
import { cn } from '@/lib/cn';

interface TableTileProps {
  table: FloorTable;
  onSeatWalkIn?: (table: FloorTable) => void;
  onSeatReservation?: (table: FloorTable) => void;
  onOpenStatusModal?: (table: FloorTable) => void;
  onViewOrder?: (orderId: string, table: FloorTable) => void;
  onReassign?: (table: FloorTable) => void;
  onRefresh?: () => void;
}

export function TableTile({
  table,
  onSeatWalkIn,
  onSeatReservation,
  onOpenStatusModal,
  onViewOrder,
  onReassign,
  onRefresh,
}: TableTileProps) {
  const now = useServerNow();
  const { settings } = useConsole();
  const currency = settings?.currency ?? 'INR';
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const { floorStatus, physicalStatus, current, next, order, dwell } = table;

  // Live dwell clock calculations using BR-10 dynamic turn timer (100% amber, 125% red)
  const seatedAtIso = current?.seatedAt || dwell?.seatedAt;
  const elapsedSecs =
    seatedAtIso && now > 0
      ? Math.max(0, Math.floor((now - Date.parse(seatedAtIso)) / 1000))
      : (dwell?.elapsedSecs ?? 0);

  const partySize = current?.partySize ?? table.maxCapacity;
  const turnMinutes = partySize <= 2 ? 75 : partySize <= 4 ? 90 : 120;
  const timer = seatedAtIso && now > 0 ? timerState(Date.parse(seatedAtIso), turnMinutes, now) : null;
  const isDwellAmber = floorStatus === 'OCCUPIED' && timer?.level === 'amber';
  const isDwellRed = floorStatus === 'OCCUPIED' && timer?.level === 'red';

  async function handleMarkClean() {
    setLoadingAction('clean');
    try {
      await send('POST', `/admin/tables/${table.id}/status`, { status: 'AVAILABLE' });
      toast.success(`Table ${table.tableNumber} is now clean and available`);
      onRefresh?.();
    } catch (e) {
      toast.error('Failed to update table status', { description: apiMessage(e) });
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleUnblock() {
    setLoadingAction('unblock');
    try {
      await send('POST', `/admin/tables/${table.id}/status`, { status: 'AVAILABLE' });
      toast.success(`Table ${table.tableNumber} unblocked`);
      onRefresh?.();
    } catch (e) {
      toast.error('Failed to unblock table', { description: apiMessage(e) });
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleCompleteTable() {
    if (!current?.reservationId) return;
    setLoadingAction('complete');
    try {
      await send('POST', `/admin/reservations/${current.reservationId}/complete`);
      toast.success(`Table ${table.tableNumber} marked complete (now bussing)`);
      onRefresh?.();
    } catch (e) {
      toast.error('Failed to complete seating', { description: apiMessage(e) });
    } finally {
      setLoadingAction(null);
    }
  }

  // Border & background accents based on status and dwell
  const borderTone = isDwellRed
    ? 'border-red ring-1 ring-red/30 bg-red-soft/20'
    : isDwellAmber
      ? 'border-amber ring-1 ring-amber/30 bg-amber-soft/20'
      : next?.status === 'ARRIVED'
        ? 'border-emerald-500 ring-2 ring-emerald-500/40 bg-emerald-50/15'
        : floorStatus === 'OCCUPIED'
          ? 'border-blue/30 bg-background'
          : floorStatus === 'RESERVED'
            ? 'border-amber/40 bg-amber-soft/10'
            : floorStatus === 'BUSSING'
              ? 'border-yellow/40 bg-yellow-soft/10'
              : floorStatus === 'BLOCKED'
                ? 'border-slate/40 bg-slate-soft/30 opacity-80'
                : 'border-border bg-background hover:border-gray-500';

  return (
    <Card
      className={cn(
        'group relative flex flex-col justify-between rounded-xl border p-3.5 shadow-sm transition-all duration-150',
        borderTone,
      )}
    >
      {/* Top Header: Table Number + Capacity + Floor Status */}
      <div>
        <div className="flex items-start justify-between gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <span className="text-base font-bold tracking-tight text-gray-1000 tabular">
              {table.tableNumber}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-800 tabular shrink-0">
              <Armchair size={12} className="text-gray-700" />
              {table.minCapacity === table.maxCapacity
                ? `${table.maxCapacity}s`
                : `${table.minCapacity}–${table.maxCapacity}s`}
            </span>
            {table.isCombination && (
              <Badge
                tone="accent"
                className="h-4 px-1.5 text-[9px] font-semibold shrink-0"
                title={`Multi-table combination: ${table.combinedTableNumbers?.join(' + ')}`}
              >
                Combo {table.combinedTableNumbers?.join('+')}
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <StatusBadge status={floorStatus} className="text-[11px]" />
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen(!menuOpen)}
                className="rounded p-1 text-gray-700 hover:bg-gray-100 hover:text-gray-1000"
                aria-label="Table options"
              >
                <MoreVertical size={14} />
              </button>

              {menuOpen ? (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-border bg-background p-1 shadow-lg text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        onOpenStatusModal?.(table);
                      }}
                      className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-gray-1000 hover:bg-gray-100"
                    >
                      <Sparkles size={13} className="text-gray-800" />
                      Manage Table Status
                    </button>
                    {floorStatus === 'AVAILABLE' && (
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          onSeatWalkIn?.(table);
                        }}
                        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-gray-1000 hover:bg-gray-100"
                      >
                        <UserCheck size={13} className="text-gray-800" />
                        Seat Walk-in Here
                      </button>
                    )}
                    {next && onReassign && (
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          onReassign(table);
                        }}
                        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-gray-1000 hover:bg-gray-100"
                      >
                        <Users size={13} className="text-gray-800" />
                        Reassign Next Guest
                      </button>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>

        {/* Dynamic Body content depending on status */}
        <div className="mt-3 min-h-[76px] space-y-2">
          {/* OCCUPIED STATE */}
          {floorStatus === 'OCCUPIED' && current && (
            <div>
              <div className="flex items-baseline justify-between gap-1">
                <span className="truncate text-xs font-semibold text-gray-1000" title={current.guestName}>
                  {current.guestName}
                </span>
                <span className="shrink-0 text-[11px] font-medium text-gray-800 tabular">
                  {current.partySize} {current.partySize === 1 ? 'guest' : 'guests'}
                </span>
              </div>

              {/* Warnings / Badges */}
              <div className="mt-1 flex flex-wrap gap-1">
                {current.allergies && (
                  <Badge tone="red" className="h-4 px-1.5 text-[10px]">
                    Allergy: {current.allergies}
                  </Badge>
                )}
                {current.tags?.includes('VIP') && (
                  <Badge tone="accent" className="h-4 px-1.5 text-[10px]">
                    VIP
                  </Badge>
                )}
                {current.tags?.filter((t) => t !== 'VIP').map((tag) => (
                  <Badge key={tag} tone="neutral" className="h-4 px-1 text-[9px]">
                    {tag}
                  </Badge>
                ))}
              </div>

              {/* Open Check indicator */}
              <div className="mt-2 flex items-center justify-between text-xs text-gray-800">
                <span className="flex items-center gap-1">
                  <Receipt size={12} className="text-gray-700" />
                  {order ? `${order.itemCount} items` : 'No order'}
                </span>
                <span className="font-semibold text-gray-1000 tabular">
                  {order ? formatMoney(order.netPaise, currency) : formatMoney(0, currency)}
                </span>
              </div>

              {/* Live Dwell Clock */}
              <div className="mt-1 flex items-center justify-between pt-1 border-t border-border/60">
                <div
                  className={cn(
                    'flex items-center gap-1.5 text-xs font-medium tabular',
                    isDwellRed
                      ? 'text-red-fg font-semibold animate-alert-pulse motion-reduce:animate-none'
                      : isDwellAmber
                        ? 'text-amber-fg font-medium'
                        : 'text-gray-800',
                  )}
                >
                  <Clock size={12} className={cn(isDwellRed ? 'text-red' : isDwellAmber ? 'text-amber' : 'text-gray-700')} />
                  <span>Dwell: {formatElapsed(elapsedSecs)}</span>
                  {isDwellRed ? (
                    <span className="rounded bg-red-soft px-1 text-[10px] uppercase font-bold text-red-fg">
                      Overstay
                    </span>
                  ) : isDwellAmber ? (
                    <span className="rounded bg-amber-soft px-1 text-[10px] uppercase font-semibold text-amber-fg">
                      Turn
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Next/Arrived reservation alert on occupied table */}
              {next && (
                <div
                  className={cn(
                    'mt-2 rounded-lg border p-2 text-xs transition-colors',
                    next.status === 'ARRIVED'
                      ? 'border-emerald-300 bg-emerald-50/90 text-emerald-950 ring-1 ring-emerald-400/50'
                      : next.status === 'LATE'
                        ? 'border-red/40 bg-red-soft/40 text-red-fg'
                        : 'border-border bg-background-2 text-gray-800',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 font-semibold text-[11px] uppercase tracking-wide">
                      {next.status === 'ARRIVED' ? (
                        <>
                          <UserCheck size={12} className="text-emerald-700" />
                          <span className="text-emerald-800 font-bold">Arrived & Waiting</span>
                        </>
                      ) : next.status === 'LATE' ? (
                        <>
                          <Clock size={12} className="text-red-fg" />
                          <span className="text-red-fg font-semibold">Late Guest</span>
                        </>
                      ) : (
                        <span className="text-blue-fg font-semibold">Next Booking</span>
                      )}
                    </span>
                    <Badge
                      tone={next.status === 'ARRIVED' ? 'green' : next.status === 'LATE' ? 'red' : 'blue'}
                      className="h-4 px-1.5 text-[9px] font-bold"
                    >
                      {next.status}
                    </Badge>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between font-medium">
                    <span className="truncate font-semibold text-gray-1000" title={next.guestName}>
                      {next.guestName}
                    </span>
                    <span className="text-[11px] text-gray-800 tabular">{next.partySize}p</span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between text-[11px] text-gray-700">
                    <span>Starts {new Date(next.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    {onReassign && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onReassign(table);
                        }}
                        className="text-[11px] font-medium text-accent hover:underline"
                      >
                        Reassign
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* RESERVED OR UPCOMING BOOKING STATE */}
          {(floorStatus === 'RESERVED' || (floorStatus === 'AVAILABLE' && next)) && next && (
            <div
              className={cn(
                'rounded-lg border p-2.5 text-xs transition-colors',
                next.status === 'ARRIVED'
                  ? 'border-emerald-300 bg-emerald-50/90 text-emerald-950 ring-1 ring-emerald-400/50'
                  : 'border-border/80 bg-background-2 text-gray-800',
              )}
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 font-bold text-[11px] uppercase tracking-wide">
                  {next.status === 'ARRIVED' ? (
                    <>
                      <UserCheck size={12} className="text-emerald-700" />
                      <span className="text-emerald-800">Arrived Guest Waiting</span>
                    </>
                  ) : (
                    <span className="text-blue-fg">Upcoming Booking</span>
                  )}
                </span>
                <Badge
                  tone={next.status === 'ARRIVED' ? 'green' : 'blue'}
                  className="h-4 px-1.5 text-[9px] font-bold"
                >
                  {next.status}
                </Badge>
              </div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="truncate font-semibold text-gray-1000">{next.guestName}</span>
                <span className="text-[11px] text-gray-800 tabular">{next.partySize} guests</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-gray-700">
                <span className="flex items-center gap-1">
                  <Clock size={11} className="text-gray-700" />
                  Starts {new Date(next.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                {onReassign && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReassign(table);
                    }}
                    className="text-[11px] font-medium text-accent hover:underline"
                  >
                    Reassign
                  </button>
                )}
              </div>
            </div>
          )}

          {/* BUSSING STATE */}
          {floorStatus === 'BUSSING' && (
            <div className="flex flex-col items-center justify-center py-2 text-center text-xs text-gray-800">
              <Sparkles size={18} className="mb-1 text-yellow-fg" />
              <span className="font-medium text-gray-1000">Table Clearing</span>
              <span className="text-[11px] text-gray-700">Needs turnover inspection</span>
            </div>
          )}

          {/* BLOCKED STATE */}
          {floorStatus === 'BLOCKED' && (
            <div className="flex flex-col items-center justify-center py-2 text-center text-xs text-gray-800">
              <AlertTriangle size={18} className="mb-1 text-slate-fg" />
              <span className="font-medium text-gray-1000">Out of Service</span>
              <span className="text-[11px] text-gray-700">Blocked for seating</span>
            </div>
          )}

          {/* AVAILABLE STATE (NO UPCOMING BOOKING) */}
          {floorStatus === 'AVAILABLE' && !next && (
            <div className="flex flex-col items-center justify-center py-2 text-center text-xs text-gray-700">
              <CheckCircle2 size={18} className="mb-1 text-success-fg opacity-80" />
              <span className="font-medium text-gray-1000">Ready for Seating</span>
              <span className="text-[11px] text-gray-700">Holds {table.maxCapacity} covers max</span>
            </div>
          )}
        </div>
      </div>

      {/* Contextual Actions Footer */}
      <div className="mt-3 flex items-center gap-1.5 pt-2 border-t border-border">
        {floorStatus === 'AVAILABLE' && !next && (
          <div className="flex w-full items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSeatWalkIn?.(table)}
              className="flex-1 min-w-0 text-xs px-2"
            >
              <UserPlus size={12} className="mr-1 shrink-0" />
              <span className="truncate">Seat Walk-in</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenStatusModal?.(table)}
              className="shrink-0 text-xs px-2.5 text-gray-800 hover:text-gray-1000"
            >
              Block
            </Button>
          </div>
        )}

        {floorStatus === 'AVAILABLE' && next && (
          <div className="flex w-full items-center gap-1.5">
            <Button
              variant="primary"
              size="sm"
              onClick={() => onSeatReservation?.(table)}
              className={cn(
                'flex-1 min-w-0 text-xs px-2',
                next.status === 'ARRIVED' && 'bg-emerald-600 hover:bg-emerald-700 text-white',
              )}
            >
              <UserCheck size={12} className="mr-1 shrink-0" />
              <span className="truncate">{next.status === 'ARRIVED' ? 'Seat Arrived' : 'Seat Booking'}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSeatWalkIn?.(table)}
              className="shrink-0 text-xs px-2 text-gray-800"
              title="Seat walk-in anyway"
            >
              Walk-in
            </Button>
          </div>
        )}

        {floorStatus === 'OCCUPIED' && (
          <div className="flex w-full items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (order?.id) onViewOrder?.(order.id, table);
              }}
              disabled={!order?.id}
              className="flex-1 min-w-0 text-xs px-2"
            >
              <UtensilsCrossed size={12} className="mr-1 shrink-0" />
              <span className="truncate">View / Settle</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={loadingAction === 'complete'}
              onClick={() => void handleCompleteTable()}
              className="shrink-0 text-xs px-2.5 text-gray-800 hover:text-gray-1000"
              title="Complete seating and send table to bussing"
            >
              Complete
            </Button>
          </div>
        )}

        {floorStatus === 'RESERVED' && (
          <div className="flex w-full items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSeatReservation?.(table)}
              className={cn(
                'flex-1 min-w-0 text-xs px-2',
                next?.status === 'ARRIVED' && 'bg-emerald-600 hover:bg-emerald-700 text-white',
              )}
            >
              <UserCheck size={12} className="mr-1 shrink-0" />
              <span className="truncate">{next?.status === 'ARRIVED' ? 'Seat Arrived' : 'Seat Booking'}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSeatWalkIn?.(table)}
              className="shrink-0 text-xs px-2 text-gray-800"
              title="Seat walk-in anyway"
            >
              Walk-in
            </Button>
          </div>
        )}

        {floorStatus === 'BUSSING' && (
          <Button
            variant="primary"
            size="sm"
            loading={loadingAction === 'clean'}
            onClick={() => void handleMarkClean()}
            className="w-full text-xs"
          >
            <Sparkles size={12} className="mr-1.5" />
            Mark Clean (Available)
          </Button>
        )}

        {floorStatus === 'BLOCKED' && (
          <Button
            variant="secondary"
            size="sm"
            loading={loadingAction === 'unblock'}
            onClick={() => void handleUnblock()}
            className="w-full text-xs"
          >
            <Unlock size={12} className="mr-1.5" />
            Unblock Table
          </Button>
        )}
      </div>
    </Card>
  );
}
