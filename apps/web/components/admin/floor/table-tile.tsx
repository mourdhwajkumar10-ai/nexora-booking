'use client';

import { useState } from 'react';
import type { FloorTable } from '@nexora/shared';
import { formatElapsed, formatINR } from '@nexora/shared';
import { useServerNow } from '../clock';
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
  onRefresh?: () => void;
}

export function TableTile({
  table,
  onSeatWalkIn,
  onSeatReservation,
  onOpenStatusModal,
  onViewOrder,
  onRefresh,
}: TableTileProps) {
  const now = useServerNow();
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const { floorStatus, physicalStatus, current, next, order, dwell } = table;

  // Live dwell clock calculations
  const seatedAtIso = current?.seatedAt || dwell?.seatedAt;
  const elapsedSecs =
    seatedAtIso && now > 0
      ? Math.max(0, Math.floor((now - Date.parse(seatedAtIso)) / 1000))
      : (dwell?.elapsedSecs ?? 0);

  const elapsedMins = Math.floor(elapsedSecs / 60);
  const isDwellAmber = floorStatus === 'OCCUPIED' && elapsedMins >= 30 && elapsedMins < 45;
  const isDwellRed = floorStatus === 'OCCUPIED' && elapsedMins >= 45;

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
        'group relative flex flex-col justify-between overflow-hidden rounded-xl border p-4 shadow-sm transition-all duration-150',
        borderTone,
      )}
    >
      {/* Top Header: Table Number + Capacity + Floor Status */}
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold tracking-tight text-gray-1000 tabular">
              {table.tableNumber}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-800 tabular">
              <Armchair size={12} className="text-gray-700" />
              {table.minCapacity === table.maxCapacity
                ? `${table.maxCapacity}s`
                : `${table.minCapacity}–${table.maxCapacity}s`}
            </span>
          </div>

          <div className="flex items-center gap-1">
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
                  {order ? formatINR(order.netPaise) : '₹0'}
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
            </div>
          )}

          {/* RESERVED STATE */}
          {floorStatus === 'RESERVED' && next && (
            <div className="rounded-lg bg-background-2 p-2 text-xs border border-border/80">
              <div className="text-[11px] font-medium uppercase text-blue-fg">Upcoming Booking</div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="truncate font-semibold text-gray-1000">{next.guestName}</span>
                <span className="text-[11px] text-gray-800 tabular">{next.partySize}p</span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-[11px] text-gray-800">
                <Clock size={11} className="text-gray-700" />
                <span>Starts {new Date(next.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
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

          {/* AVAILABLE STATE */}
          {floorStatus === 'AVAILABLE' && (
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
        {floorStatus === 'AVAILABLE' && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSeatWalkIn?.(table)}
              className="flex-1 text-xs"
            >
              Seat Walk-in
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenStatusModal?.(table)}
              className="text-xs text-gray-800 hover:text-gray-1000"
            >
              Block
            </Button>
          </>
        )}

        {floorStatus === 'OCCUPIED' && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (order?.id) onViewOrder?.(order.id, table);
              }}
              disabled={!order?.id}
              className="flex-1 text-xs"
            >
              <UtensilsCrossed size={12} className="mr-1" />
              View / Settle
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={loadingAction === 'complete'}
              onClick={() => void handleCompleteTable()}
              className="text-xs text-gray-800 hover:text-gray-1000"
              title="Complete seating and send table to bussing"
            >
              Complete
            </Button>
          </>
        )}

        {floorStatus === 'RESERVED' && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSeatReservation?.(table)}
              className="flex-1 text-xs"
            >
              Seat Reservation
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSeatWalkIn?.(table)}
              className="text-xs text-gray-800"
              title="Seat walk-in anyway"
            >
              Walk-in
            </Button>
          </>
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
