'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { FloorSnapshot, FloorStatus, FloorTable } from '@nexora/shared';
import { adminApi, apiMessage } from '@/components/admin/admin-api';
import { useConsole } from '@/components/admin/console-provider';
import { TableTile } from '@/components/admin/floor/table-tile';
import { WalkInDialog } from '@/components/admin/floor/walk-in-dialog';
import { TableStatusDialog } from '@/components/admin/floor/table-status-dialog';
import { OrderDrawer } from '@/components/admin/order-drawer';
import { Badge, Button, Card, CardBody, Input, Spinner } from '@/components/ui';
import {
  Armchair,
  CheckCircle2,
  Clock,
  Filter,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
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
  const { venueId, subscribe } = useConsole();

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
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {zoneTables.map((table) => (
                    <TableTile
                      key={table.id}
                      table={table}
                      onSeatWalkIn={handleOpenWalkIn}
                      onSeatReservation={handleOpenWalkIn}
                      onOpenStatusModal={handleOpenStatusModal}
                      onViewOrder={handleViewOrder}
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
    </div>
  );
}
