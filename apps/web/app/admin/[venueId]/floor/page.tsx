'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { FloorSnapshot, FloorStatus, FloorTable } from '@nexora/shared';
import { adminApi, apiMessage, send } from '@/components/admin/admin-api';
import { useConsole } from '@/components/admin/console-provider';
import { toast } from 'sonner';
import { TableTile } from '@/components/admin/floor/table-tile';
import { WalkInDialog } from '@/components/admin/floor/walk-in-dialog';
import { TableStatusDialog } from '@/components/admin/floor/table-status-dialog';
import { OrderDrawer } from '@/components/admin/order-drawer';
import { Badge, Button, Card, CardBody, Dialog, Input, Spinner } from '@/components/ui';
import {
  Armchair,
  CheckCircle2,
  Clock,
  Filter,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Shuffle,
  Sparkles,
  UserCheck,
  Users,
  UtensilsCrossed,
} from 'lucide-react';
import { cn } from '@/lib/cn';

const ZONE_ORDER = ['MAIN', 'PATIO', 'BAR', 'MEZZANINE', 'PRIVATE'];

const ZONE_LABELS: Record<string, string> = {
  MAIN: 'Main Dining Room',
  PATIO: 'Patio & Terrace',
  BAR: 'Bar & High Tops',
  MEZZANINE: 'Mezzanine',
  PRIVATE: 'Private Dining',
};

export default function FloorPlanPage() {
  const { venueId, subscribe, emit } = useConsole();

  const [snapshot, setSnapshot] = useState<FloorSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Filters & Search
  const [statusFilter, setStatusFilter] = useState<FloorStatus | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Modals & Drawers
  const [walkInOpen, setWalkInOpen] = useState<boolean>(false);
  const [walkInTable, setWalkInTable] = useState<FloorTable | null>(null);

  const [statusModalOpen, setStatusModalOpen] = useState<boolean>(false);
  const [statusModalTable, setStatusModalTable] = useState<FloorTable | null>(null);

  const [orderDrawerOpen, setOrderDrawerOpen] = useState<boolean>(false);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  // Reassign Modal State
  const [reassignModalOpen, setReassignModalOpen] = useState<boolean>(false);
  const [reassignTable, setReassignTable] = useState<FloorTable | null>(null);
  const [reassignTargetId, setReassignTargetId] = useState<string>('');
  const [submittingReassign, setSubmittingReassign] = useState<boolean>(false);

  function handleOpenReassign(table: FloorTable) {
    setReassignTable(table);
    setReassignTargetId('');
    setReassignModalOpen(true);
  }

  async function handleConfirmReassign() {
    if (!reassignTable?.next?.reservationId || !reassignTargetId) return;
    setSubmittingReassign(true);
    try {
      await send('POST', `/admin/reservations/${reassignTable.next.reservationId}/reassign`, {
        tableId: reassignTargetId,
      });
      const targetTable = snapshot?.tables.find((t) => t.id === reassignTargetId);
      toast.success(`Reassigned ${reassignTable.next.guestName} to Table ${targetTable?.tableNumber ?? ''}`);
      setReassignModalOpen(false);
      setReassignTable(null);
      emit('reservation:changed');
      emit('floor:changed');
      void loadFloor();
    } catch (e) {
      toast.error('Reassignment failed', { description: apiMessage(e) });
    } finally {
      setSubmittingReassign(false);
    }
  }

  const loadFloor = useCallback(
    async (isManualRefresh = false) => {
      if (isManualRefresh) setRefreshing(true);
      setError(null);
      try {
        const snap = await adminApi<FloorSnapshot>(`/admin/venues/${venueId}/floor`);
        setSnapshot(snap);
      } catch (err) {
        setError(apiMessage(err));
      } finally {
        setLoading(false);
        if (isManualRefresh) setRefreshing(false);
      }
    },
    [venueId],
  );

  // Initial load
  useEffect(() => {
    void loadFloor();
  }, [loadFloor]);

  // Subscribe to realtime signals
  useEffect(() => {
    return subscribe(['floor:changed', 'order:changed', 'reservation:changed', 'poll'], () => {
      void loadFloor();
    });
  }, [subscribe, loadFloor]);

  // Handle open walk-in dialog
  function handleOpenWalkIn(table?: FloorTable) {
    setWalkInTable(table ?? null);
    setWalkInOpen(true);
  }

  // Handle seat reservation directly from reserved table
  async function handleSeatReservation(table: FloorTable) {
    if (table.next?.reservationId) {
      try {
        await send('POST', `/admin/reservations/${table.next.reservationId}/seat`);
        toast.success(`Seated ${table.next.guestName || 'guest'} at Table ${table.tableNumber}`);
        emit('reservation:changed');
        emit('floor:changed');
        void loadFloor();
      } catch (e) {
        toast.error('Failed to seat reservation', { description: apiMessage(e) });
      }
    } else {
      handleOpenWalkIn(table);
    }
  }

  // Handle open status modal
  function handleOpenStatusModal(table: FloorTable) {
    setStatusModalTable(table);
    setStatusModalOpen(true);
  }

  // Handle view order
  function handleViewOrder(orderId: string) {
    setSelectedOrderId(orderId);
    setOrderDrawerOpen(true);
  }

  // Group tables by dining zone
  const tables = snapshot?.tables ?? [];

  const filteredTables = useMemo(() => {
    return tables.filter((t) => {
      if (statusFilter !== 'ALL' && t.floorStatus !== statusFilter) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      const matchNum = t.tableNumber.toLowerCase().includes(q);
      const matchGuest = t.current?.guestName?.toLowerCase().includes(q);
      const matchNext = t.next?.guestName?.toLowerCase().includes(q);
      return matchNum || matchGuest || matchNext;
    });
  }, [tables, statusFilter, searchQuery]);

  const tablesByZone = useMemo(() => {
    const map = new Map<string, FloorTable[]>();
    for (const table of filteredTables) {
      const z = table.diningZone.toUpperCase();
      if (!map.has(z)) map.set(z, []);
      map.get(z)!.push(table);
    }

    // Sort zones by ZONE_ORDER
    const zones = Array.from(map.keys()).sort((a, b) => {
      const ia = ZONE_ORDER.indexOf(a);
      const ib = ZONE_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });

    return zones.map((zone) => ({
      zone,
      label: ZONE_LABELS[zone] ?? zone,
      tables: map.get(zone)!.sort((a, b) => a.tableNumber.localeCompare(b.tableNumber, undefined, { numeric: true })),
    }));
  }, [filteredTables]);

  const counts = snapshot?.counts ?? {
    AVAILABLE: 0,
    RESERVED: 0,
    OCCUPIED: 0,
    BUSSING: 0,
    BLOCKED: 0,
  };

  const covers = snapshot?.covers ?? { seated: 0, capacity: 0 };
  const occupancyPct = covers.capacity > 0 ? Math.round((covers.seated / covers.capacity) * 100) : 0;

  // Unique arrived guests waiting for tables
  const arrivedGuests = useMemo(() => {
    if (!snapshot) return [];
    const map = new Map<
      string,
      {
        reservationId: string;
        guestName: string;
        partySize: number;
        startAt: string;
        tableId: string;
        tableNumber: string;
        tableStatus: FloorStatus;
        currentGuestName?: string;
      }
    >();
    for (const t of snapshot.tables) {
      if (t.next && t.next.status === 'ARRIVED') {
        if (!map.has(t.next.reservationId)) {
          map.set(t.next.reservationId, {
            reservationId: t.next.reservationId,
            guestName: t.next.guestName,
            partySize: t.next.partySize,
            startAt: t.next.startAt,
            tableId: t.id,
            tableNumber: t.tableNumber,
            tableStatus: t.floorStatus,
            currentGuestName: t.current?.guestName,
          });
        }
      }
    }
    return Array.from(map.values());
  }, [snapshot]);

  return (
    <div className="space-y-6">
      {/* Top Header: KPI cards + Actions */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-gray-1000">Interactive Floor Plan</h1>
          <p className="mt-0.5 text-xs text-gray-800">
            Real-time table allocation, active order checks, dwell times, and turn controls
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadFloor(true)}
            loading={refreshing}
            className="text-xs"
            title="Refresh floor view"
          >
            <RefreshCw size={13} className={cn('mr-1.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={() => handleOpenWalkIn()}
            className="text-xs"
          >
            <Plus size={14} className="mr-1.5" />
            Seat Walk-in
          </Button>
        </div>
      </div>

      {/* Arrived Guests Waiting Notice */}
      {arrivedGuests.length > 0 && (
        <div className="rounded-xl border border-emerald-300 bg-emerald-50/90 p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="relative flex size-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500"></span>
              </span>
              <h2 className="text-sm font-bold text-emerald-950">
                {arrivedGuests.length} Arrived {arrivedGuests.length === 1 ? 'Guest Waiting at Front Desk' : 'Guests Waiting'}
              </h2>
            </div>
            <Badge tone="green" className="font-semibold text-xs">
              {arrivedGuests.length} Checked In
            </Badge>
          </div>
          <div className="mt-3 divide-y divide-emerald-200/60 rounded-lg border border-emerald-200 bg-white">
            {arrivedGuests.map((g) => {
              const assignedT = tables.find((t) => t.id === g.tableId);
              return (
                <div key={g.reservationId} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-gray-1000">{g.guestName}</span>
                      <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-800 tabular">
                        <Users size={12} /> {g.partySize} guests
                      </span>
                      <Badge tone="accent" className="text-xs font-semibold">
                        Table {g.tableNumber}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-gray-700">
                      Reserved for {new Date(g.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
                      {g.tableStatus === 'AVAILABLE' ? (
                        <span className="font-semibold text-emerald-700">Table {g.tableNumber} is clean & ready to seat!</span>
                      ) : (
                        <span className="text-amber-700 font-medium">
                          Table {g.tableNumber} is currently occupied ({g.currentGuestName || 'Seated'})
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {assignedT && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => handleSeatReservation(assignedT)}
                        className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                      >
                        <UserCheck size={13} className="mr-1.5" />
                        Seat at Table {g.tableNumber}
                      </Button>
                    )}
                    {assignedT && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleOpenReassign(assignedT)}
                        className="text-xs"
                      >
                        <Shuffle size={13} className="mr-1.5" />
                        Reassign Table
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Summary KPI Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {/* Covers Seated */}
        <Card className="p-3.5 bg-background border-border shadow-sm">
          <div className="flex items-center justify-between text-xs text-gray-800">
            <span className="font-medium">Covers Seated</span>
            <Armchair size={14} className="text-gray-700" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-xl font-bold text-gray-1000 tabular">{covers.seated}</span>
            <span className="text-xs text-gray-800 tabular">/ {covers.capacity} max</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className={cn(
                'h-full transition-all duration-300',
                occupancyPct > 80 ? 'bg-amber' : 'bg-gray-1000',
              )}
              style={{ width: `${Math.min(100, occupancyPct)}%` }}
            />
          </div>
        </Card>

        {/* Available Filter Chip */}
        <Card
          onClick={() => setStatusFilter(statusFilter === 'AVAILABLE' ? 'ALL' : 'AVAILABLE')}
          className={cn(
            'p-3.5 cursor-pointer border transition-colors shadow-sm',
            statusFilter === 'AVAILABLE'
              ? 'border-success bg-success-soft ring-1 ring-success'
              : 'border-border bg-background hover:border-gray-400',
          )}
        >
          <div className="flex items-center justify-between text-xs text-success-fg">
            <span className="font-semibold">Available</span>
            <span className="size-2 rounded-full bg-success" />
          </div>
          <div className="mt-2 text-xl font-bold text-gray-1000 tabular">{counts.AVAILABLE}</div>
          <div className="mt-1 text-[11px] text-gray-800">Ready to seat</div>
        </Card>

        {/* Reserved Filter Chip */}
        <Card
          onClick={() => setStatusFilter(statusFilter === 'RESERVED' ? 'ALL' : 'RESERVED')}
          className={cn(
            'p-3.5 cursor-pointer border transition-colors shadow-sm',
            statusFilter === 'RESERVED'
              ? 'border-blue bg-blue-soft ring-1 ring-blue'
              : 'border-border bg-background hover:border-gray-400',
          )}
        >
          <div className="flex items-center justify-between text-xs text-blue-fg">
            <span className="font-semibold">Reserved</span>
            <span className="size-2 rounded-full bg-blue" />
          </div>
          <div className="mt-2 text-xl font-bold text-gray-1000 tabular">{counts.RESERVED}</div>
          <div className="mt-1 text-[11px] text-gray-800">Upcoming arrivals</div>
        </Card>

        {/* Occupied Filter Chip */}
        <Card
          onClick={() => setStatusFilter(statusFilter === 'OCCUPIED' ? 'ALL' : 'OCCUPIED')}
          className={cn(
            'p-3.5 cursor-pointer border transition-colors shadow-sm',
            statusFilter === 'OCCUPIED'
              ? 'border-amber bg-amber-soft ring-1 ring-amber'
              : 'border-border bg-background hover:border-gray-400',
          )}
        >
          <div className="flex items-center justify-between text-xs text-amber-fg">
            <span className="font-semibold">Occupied</span>
            <span className="size-2 rounded-full bg-amber" />
          </div>
          <div className="mt-2 text-xl font-bold text-gray-1000 tabular">{counts.OCCUPIED}</div>
          <div className="mt-1 text-[11px] text-gray-800">Active dining</div>
        </Card>

        {/* Bussing Filter Chip */}
        <Card
          onClick={() => setStatusFilter(statusFilter === 'BUSSING' ? 'ALL' : 'BUSSING')}
          className={cn(
            'p-3.5 cursor-pointer border transition-colors shadow-sm',
            statusFilter === 'BUSSING'
              ? 'border-yellow bg-yellow-soft ring-1 ring-yellow'
              : 'border-border bg-background hover:border-gray-400',
          )}
        >
          <div className="flex items-center justify-between text-xs text-yellow-fg">
            <span className="font-semibold">Bussing</span>
            <span className="size-2 rounded-full bg-yellow" />
          </div>
          <div className="mt-2 text-xl font-bold text-gray-1000 tabular">{counts.BUSSING}</div>
          <div className="mt-1 text-[11px] text-gray-800">Clearing & reset</div>
        </Card>

        {/* Blocked Filter Chip */}
        <Card
          onClick={() => setStatusFilter(statusFilter === 'BLOCKED' ? 'ALL' : 'BLOCKED')}
          className={cn(
            'p-3.5 cursor-pointer border transition-colors shadow-sm',
            statusFilter === 'BLOCKED'
              ? 'border-slate bg-slate-soft ring-1 ring-slate'
              : 'border-border bg-background hover:border-gray-400',
          )}
        >
          <div className="flex items-center justify-between text-xs text-slate-fg">
            <span className="font-semibold">Blocked</span>
            <span className="size-2 rounded-full bg-slate" />
          </div>
          <div className="mt-2 text-xl font-bold text-gray-1000 tabular">{counts.BLOCKED}</div>
          <div className="mt-1 text-[11px] text-gray-800">Out of service</div>
        </Card>
      </div>

      {/* Filter / Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background p-3 shadow-sm">
        <div className="flex items-center gap-2">
          <Filter size={15} className="text-gray-800" />
          <span className="text-xs font-semibold text-gray-1000">Filter by Status:</span>
          <div className="flex flex-wrap gap-1">
            {(['ALL', 'AVAILABLE', 'RESERVED', 'OCCUPIED', 'BUSSING', 'BLOCKED'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  statusFilter === s
                    ? 'bg-gray-1000 text-white'
                    : 'text-gray-800 hover:bg-gray-100 hover:text-gray-1000',
                )}
              >
                {s === 'ALL' ? 'All Tables' : s}
              </button>
            ))}
          </div>
        </div>

        <div className="relative w-full sm:w-64">
          <Input
            placeholder="Search table, guest name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-700" />
        </div>
      </div>

      {/* Main Floor Grid: Grouped by Dining Zone */}
      {loading && !snapshot ? (
        <div className="flex h-64 flex-col items-center justify-center gap-2 text-xs text-gray-800">
          <Spinner size={20} />
          <span>Synchronizing floor state…</span>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red/20 bg-red-soft p-6 text-center text-xs text-red-fg">
          <p className="font-semibold">Unable to load floor plan</p>
          <p className="mt-1">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => void loadFloor(true)} className="mt-3">
            Retry
          </Button>
        </div>
      ) : tablesByZone.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center text-xs text-gray-800">
          No dining tables match your active filters.
        </div>
      ) : (
        <div className="space-y-8">
          {tablesByZone.map(({ zone, label, tables: zoneTables }) => {
            const seatedInZone = zoneTables.reduce((acc, t) => acc + (t.current?.partySize ?? 0), 0);
            const capacityInZone = zoneTables.reduce((acc, t) => acc + t.maxCapacity, 0);

            return (
              <section key={zone} className="space-y-3">
                {/* Zone Header */}
                <div className="flex items-baseline justify-between border-b border-border pb-2">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold tracking-tight text-gray-1000 uppercase">
                      {label}
                    </h2>
                    <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-gray-800 tabular">
                      {zoneTables.length} {zoneTables.length === 1 ? 'table' : 'tables'}
                    </span>
                  </div>

                  <span className="text-xs text-gray-800 tabular">
                    {seatedInZone} / {capacityInZone} covers active
                  </span>
                </div>

                {/* Tables Grid */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                  {zoneTables.map((table) => (
                    <TableTile
                      key={table.id}
                      table={table}
                      onSeatWalkIn={handleOpenWalkIn}
                      onSeatReservation={handleSeatReservation}
                      onOpenStatusModal={handleOpenStatusModal}
                      onViewOrder={handleViewOrder}
                      onReassign={handleOpenReassign}
                      onRefresh={loadFloor}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Walk-In Modal */}
      <WalkInDialog
        open={walkInOpen}
        onClose={() => setWalkInOpen(false)}
        tables={tables}
        preselectedTable={walkInTable}
        onSuccess={loadFloor}
      />

      {/* Table Status Modal */}
      <TableStatusDialog
        open={statusModalOpen}
        onClose={() => setStatusModalOpen(false)}
        table={statusModalTable}
        onSuccess={loadFloor}
      />

      {/* Order Drawer */}
      <OrderDrawer
        open={orderDrawerOpen}
        onClose={() => setOrderDrawerOpen(false)}
        orderId={selectedOrderId}
        venueId={venueId}
        onOrderUpdated={loadFloor}
      />

      {/* Reassign Reservation Modal */}
      <Dialog
        open={reassignModalOpen}
        onClose={() => setReassignModalOpen(false)}
        title="Reassign Table"
        description={
          reassignTable?.next
            ? `Move ${reassignTable.next.guestName} (${reassignTable.next.partySize} guests) from Table ${reassignTable.tableNumber} to another dining table.`
            : 'Select a destination table for this reservation.'
        }
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReassignModalOpen(false)}
              disabled={submittingReassign}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submittingReassign}
              disabled={!reassignTargetId}
              onClick={() => void handleConfirmReassign()}
            >
              Confirm Reassignment
            </Button>
          </>
        }
      >
        <div className="space-y-4 pt-2">
          <div>
            <label htmlFor="reassign-target" className="mb-1 block text-xs font-semibold text-gray-800">
              Select Destination Table
            </label>
            <select
              id="reassign-target"
              value={reassignTargetId}
              onChange={(e) => setReassignTargetId(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-gray-1000 focus:border-accent focus:outline-none"
            >
              <option value="">-- Choose an available table --</option>
              {tables
                .filter((t) => t.id !== reassignTable?.id && t.floorStatus !== 'BLOCKED')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    Table {t.tableNumber} ({t.diningZone} · {t.minCapacity}–{t.maxCapacity} covers) — {t.floorStatus}
                  </option>
                ))}
            </select>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
