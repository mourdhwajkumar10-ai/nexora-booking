'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  Flame,
  Info,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  TrendingUp,
  User,
  UserCheck,
  UtensilsCrossed,
  XCircle,
} from 'lucide-react';
import {
  DEFAULT_VOID_REASON_MAPPINGS,
  VOID_REASONS,
  formatMoney,
  type AttributionClass,
  type FloorSnapshot,
  type GuestProfileDto,
  type OrderDetail,
  type VoidReason,
} from '@nexora/shared';
import { adminApi, apiMessage, send } from '@/components/admin/admin-api';
import { useConsole } from '@/components/admin/console-provider';
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
  Spinner,
  StatusBadge,
} from '@/components/ui';
import { cn } from '@/lib/cn';

interface PosAdjustmentLog {
  id: string;
  orderId: string;
  tableNumber?: string;
  guestName: string;
  itemName: string;
  kind: string;
  reasonRef: string;
  attributionClass: AttributionClass;
  countsAsGuestReturn: boolean;
  amountPaise: number;
  authorizedBy: string;
  createdAt: string;
}

interface OrderSummaryItem {
  id: string;
  tableId: string;
  tableNumber: string;
  guestId: string | null;
  guestName: string | null;
  guestPhone: string | null;
  status: string;
  placedAt: string;
  itemCount: number;
  grossPaise: number;
  netPaise: number;
  discountPaise: number;
  paidPaise: number;
}

export default function PosManagementPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = React.use(params);
  const { isManager, settings, subscribe, emit, me } = useConsole();
  const currency = settings?.currency ?? 'INR';

  const [orders, setOrders] = useState<OrderSummaryItem[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [activeOrderDetail, setActiveOrderDetail] = useState<OrderDetail | null>(null);
  const [adjustments, setAdjustments] = useState<PosAdjustmentLog[]>([]);
  const [guestProfile, setGuestProfile] = useState<GuestProfileDto | null>(null);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Void modal state
  const [voidModalItem, setVoidModalItem] = useState<{ id: string; name: string; lineTotalPaise: number } | null>(null);
  const [voidReason, setVoidReason] = useState<VoidReason>('KITCHEN_ERROR');
  const [voidAuthorizedBy, setVoidAuthorizedBy] = useState(me?.user?.name || 'Floor Manager');
  const [submittingVoid, setSubmittingVoid] = useState(false);

  // Load orders and adjustment audit logs
  const loadOrdersAndAudit = useCallback(async () => {
    try {
      const [ordersData, adjData] = await Promise.all([
        adminApi<OrderSummaryItem[]>(`/admin/venues/${venueId}/orders`).catch(() => []),
        adminApi<PosAdjustmentLog[]>(`/admin/venues/${venueId}/pos/adjustments`).catch(() => []),
      ]);
      setOrders(ordersData);
      setAdjustments(adjData);

      if (ordersData.length > 0 && !selectedOrderId) {
        setSelectedOrderId(ordersData[0].id);
      }
    } catch (e) {
      toast.error('Could not load POS orders', { description: apiMessage(e) });
    } finally {
      setLoadingOrders(false);
    }
  }, [venueId, selectedOrderId]);

  // Load active order details
  const loadOrderDetail = useCallback(async (orderId: string) => {
    setLoadingDetail(true);
    try {
      const detail = await adminApi<OrderDetail>(`/admin/orders/${orderId}`);
      setActiveOrderDetail(detail);

      // If order has a linked guest, inspect their CRM profile
      if (detail.guestId) {
        try {
          const profile = await adminApi<GuestProfileDto>(`/admin/guests/${detail.guestId}`);
          setGuestProfile(profile);
        } catch {
          setGuestProfile(null);
        }
      } else {
        setGuestProfile(null);
      }
    } catch (e) {
      toast.error('Could not load order detail', { description: apiMessage(e) });
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void loadOrdersAndAudit();
  }, [loadOrdersAndAudit]);

  useEffect(() => {
    if (selectedOrderId) {
      void loadOrderDetail(selectedOrderId);
    } else {
      setActiveOrderDetail(null);
      setGuestProfile(null);
    }
  }, [selectedOrderId, loadOrderDetail]);

  // Real-time signals
  useEffect(() => {
    return subscribe(['order:changed', 'floor:changed', 'poll'], () => {
      void loadOrdersAndAudit();
      if (selectedOrderId) void loadOrderDetail(selectedOrderId);
    });
  }, [subscribe, loadOrdersAndAudit, selectedOrderId, loadOrderDetail]);

  // Handle Demo Check creation
  const handleCreateDemoCheck = async () => {
    setActionLoading('demo-check');
    try {
      const res = await send<{ orderId: string; tableNumber: string }>('POST', `/admin/venues/${venueId}/pos/demo-check`);
      toast.success(`Demo check opened on Table ${res.tableNumber}`);
      emit('order:changed');
      emit('floor:changed');
      setSelectedOrderId(res.orderId);
      void loadOrdersAndAudit();
    } catch (e) {
      toast.error('Failed to create demo check', { description: apiMessage(e) });
    } finally {
      setActionLoading(null);
    }
  };

  // Handle Void Item
  const handleConfirmVoid = async () => {
    if (!activeOrderDetail || !voidModalItem) return;
    setSubmittingVoid(true);
    try {
      const auth = voidAuthorizedBy.trim() || me?.user?.name || 'Floor Manager';
      await send('POST', `/admin/venues/${venueId}/pos/simulate`, {
        body: {
          type: 'order.item_voided',
          eventId: `pos_void_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          orderId: activeOrderDetail.id,
          orderItemId: voidModalItem.id,
          reason: voidReason,
          authorizedBy: auth,
        },
      });

      const attr = DEFAULT_VOID_REASON_MAPPINGS[voidReason] || 'OPERATIONS';
      const isShielded = attr === 'KITCHEN' || attr === 'SERVER_ENTRY';
      toast.success(`Dish "${voidModalItem.name}" voided successfully`, {
        description: isShielded
          ? `Fair attribution: ${attr}. Diner CRM profile protected (0 penalty strikes).`
          : `Attributed to ${attr}. Customer return recorded.`,
      });

      setVoidModalItem(null);
      emit('order:changed');
      emit('floor:changed');
      void loadOrdersAndAudit();
      if (selectedOrderId) void loadOrderDetail(selectedOrderId);
    } catch (e) {
      toast.error('Void failed', { description: apiMessage(e) });
    } finally {
      setSubmittingVoid(false);
    }
  };

  const selectedOrder = useMemo(
    () => orders.find((o) => o.id === selectedOrderId) ?? null,
    [orders, selectedOrderId],
  );

  const totalOpenNetPaise = useMemo(
    () => orders.reduce((sum, o) => sum + (o.netPaise || 0), 0),
    [orders],
  );

  const shieldedAdjustments = useMemo(
    () => adjustments.filter((a) => !a.countsAsGuestReturn),
    [adjustments],
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-gray-1000">
              POS Terminal & Fair Void Management
            </h1>
            <Badge tone="blue" className="gap-1 text-xs">
              <ShieldCheck size={13} className="text-blue-fg" /> BR-13 Active
            </Badge>
          </div>
          <p className="mt-1 text-sm text-gray-800">
            Real-time table orders, kitchen/staff defect attribution, and guest CRM profile protection in{' '}
            <strong className="text-gray-1000">{currency === 'USD' ? 'USD ($)' : 'INR (₹)'}</strong>.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleCreateDemoCheck()}
            loading={actionLoading === 'demo-check'}
            className="gap-1.5 text-xs"
          >
            <Plus size={14} /> Open Demo Check
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void loadOrdersAndAudit();
              if (selectedOrderId) void loadOrderDetail(selectedOrderId);
            }}
            loading={loadingOrders}
            className="text-xs"
            title="Refresh checks"
          >
            <RefreshCw size={13} />
          </Button>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Card>
          <CardBody className="p-5">
            <span className="text-xs font-medium text-gray-700 block">Active Checks</span>
            <span className="mt-1 text-2xl font-bold text-gray-1000 tabular block">
              {orders.length}
            </span>
            <span className="text-[11px] text-gray-700 mt-0.5 block">Dining room orders open</span>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-5">
            <span className="text-xs font-medium text-gray-700 block">Open Folio Value</span>
            <span className="mt-1 text-2xl font-bold text-gray-1000 tabular block">
              {formatMoney(totalOpenNetPaise, currency)}
            </span>
            <span className="text-[11px] text-gray-700 mt-0.5 block">Current dining room spend</span>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-5">
            <span className="text-xs font-medium text-gray-700 block">Shielded Operational Voids</span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-emerald-600 tabular">
                {shieldedAdjustments.length}
              </span>
              <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success-fg">
                100% Protected
              </span>
            </div>
            <span className="text-[11px] text-gray-700 mt-0.5 block">Kitchen/server errors isolated</span>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="p-5">
            <span className="text-xs font-medium text-gray-700 block">Attributed Diner Returns</span>
            <span className="mt-1 text-2xl font-bold text-amber-600 tabular block">
              {adjustments.filter((a) => a.countsAsGuestReturn).length}
            </span>
            <span className="text-[11px] text-gray-700 mt-0.5 block">Legitimate customer rejections</span>
          </CardBody>
        </Card>
      </div>

      {/* Main Interactive Grid: Left Check Selector & Items, Right Guest Shield & Audit */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        {/* Left: Active Checks & Selected Order Items (7 cols) */}
        <div className="space-y-6 lg:col-span-7">
          {/* Order Selector Tabs */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Receipt size={16} className="text-gray-800" />
                Active Dining Checks ({orders.length})
              </CardTitle>
              {selectedOrder ? (
                <StatusBadge status={selectedOrder.status} className="text-[11px]" />
              ) : null}
            </CardHeader>

            <CardBody className="pt-0">
              {orders.length === 0 ? (
                <div className="py-6 text-center text-xs text-gray-700">
                  <p>No open dining checks on the floor right now.</p>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleCreateDemoCheck()}
                    className="mt-3 text-xs"
                  >
                    <Plus size={13} className="mr-1" /> Create Demo Dining Check
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                  {orders.map((o) => {
                    const isSelected = o.id === selectedOrderId;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => setSelectedOrderId(o.id)}
                        className={cn(
                          'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors',
                          isSelected
                            ? 'border-gray-1000 bg-gray-1000 text-white font-medium shadow-sm'
                            : 'border-border bg-background hover:bg-background-2 text-gray-900',
                        )}
                      >
                        <UtensilsCrossed size={13} className={isSelected ? 'text-white' : 'text-gray-700'} />
                        <span className="font-semibold">Table {o.tableNumber}</span>
                        <span className="opacity-75">· {formatMoney(o.netPaise, currency)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardBody>
          </Card>

          {/* Selected Order Detail & Line Items */}
          {activeOrderDetail ? (
            <Card className="border-border">
              <CardHeader className="flex flex-row items-center justify-between pb-3 border-b border-border">
                <div>
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base font-bold text-gray-1000">
                      Table {selectedOrder?.tableNumber ?? 'Seating'} Folio
                    </CardTitle>
                    <Badge tone="blue" className="text-[10px]">
                      {activeOrderDetail.status}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-800">
                    Guest: <strong className="text-gray-1000">{activeOrderDetail.guestName || 'Valued Diner'}</strong> ·{' '}
                    Placed at {new Date(activeOrderDetail.placedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>

                <div className="text-right">
                  <span className="text-[11px] text-gray-700 uppercase block">Check Net Total</span>
                  <span className="text-lg font-bold text-gray-1000 tabular">
                    {formatMoney(activeOrderDetail.netPaise, currency)}
                  </span>
                </div>
              </CardHeader>

              <CardBody className="p-0">
                {/* Items Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border bg-background-2 text-gray-800 font-medium">
                        <th className="px-4 py-2.5">Item & Course</th>
                        <th className="px-3 py-2.5 text-center">Qty</th>
                        <th className="px-4 py-2.5 text-right">Price</th>
                        <th className="px-4 py-2.5 text-right">Total</th>
                        <th className="px-4 py-2.5 text-right">Fair Void</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {activeOrderDetail.items.map((item) => (
                        <tr
                          key={item.id}
                          className={cn(
                            'hover:bg-background-2/40 transition-colors',
                            item.isVoided && 'bg-red-soft/20 text-gray-700',
                          )}
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span className={cn('font-medium text-gray-1000', item.isVoided && 'line-through text-gray-700')}>
                                {item.itemName}
                              </span>
                              <span className="rounded bg-gray-100 px-1.5 py-0.2 text-[9px] uppercase text-gray-800">
                                {item.category}
                              </span>
                              {item.isVoided ? (
                                <Badge tone="red" className="h-4 px-1.5 text-[9px]">
                                  Voided
                                </Badge>
                              ) : null}
                            </div>
                            {item.notes ? (
                              <span className="text-[11px] text-gray-700 block italic">“{item.notes}”</span>
                            ) : null}
                          </td>

                          <td className="px-3 py-3 text-center tabular font-medium text-gray-1000">
                            {item.quantity}
                          </td>

                          <td className="px-4 py-3 text-right tabular text-gray-800">
                            {formatMoney(item.unitPricePaise, currency)}
                          </td>

                          <td className="px-4 py-3 text-right font-semibold tabular text-gray-1000">
                            <span className={cn(item.isVoided && 'line-through text-gray-700')}>
                              {formatMoney(item.lineTotalPaise, currency)}
                            </span>
                          </td>

                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            {!item.isVoided ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                  setVoidModalItem({
                                    id: item.id,
                                    name: item.itemName,
                                    lineTotalPaise: item.lineTotalPaise,
                                  });
                                  setVoidReason('KITCHEN_ERROR');
                                }}
                                className="h-6 px-2 text-[11px] text-amber-fg hover:bg-amber-soft"
                              >
                                <AlertTriangle size={11} className="mr-1" /> Void Item
                              </Button>
                            ) : (
                              <span className="text-[11px] text-gray-700 italic">Adjusted</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Summary footer */}
                <div className="flex items-center justify-between border-t border-border bg-background-2 p-4 text-xs">
                  <div className="flex items-center gap-3">
                    <span className="text-gray-800">
                      Gross: <strong className="text-gray-1000">{formatMoney(activeOrderDetail.grossPaise, currency)}</strong>
                    </span>
                    {activeOrderDetail.discountPaise > 0 ? (
                      <span className="text-success-fg">
                        Voids / Discs: <strong>-{formatMoney(activeOrderDetail.discountPaise, currency)}</strong>
                      </span>
                    ) : null}
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-gray-800">Net Due: </span>
                    <span className="font-bold text-gray-1000 text-sm tabular">
                      {formatMoney(activeOrderDetail.netPaise, currency)}
                    </span>
                  </div>
                </div>
              </CardBody>
            </Card>
          ) : loadingDetail ? (
            <Card className="p-8 text-center text-xs text-gray-700">
              <Spinner size={18} className="mx-auto mb-2" />
              Loading order details…
            </Card>
          ) : null}
        </div>

        {/* Right: Customer CRM Shield Inspection & Fair Void Audit (5 cols) */}
        <div className="space-y-6 lg:col-span-5">
          {/* Guest Profile CRM Shield Inspection Card */}
          <Card className="border-border shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={18} className="text-emerald-600" />
                <CardTitle className="text-sm font-semibold">
                  Customer Profile CRM Shield
                </CardTitle>
              </div>
              <Badge tone="green" className="text-[10px]">
                Active Protection
              </Badge>
            </CardHeader>

            <CardBody className="space-y-4 pt-1">
              {guestProfile ? (
                <>
                  <div className="flex items-center justify-between rounded-lg bg-background-2 p-3 text-xs border border-border">
                    <div>
                      <span className="font-bold text-gray-1000 text-sm block">{guestProfile.name}</span>
                      <span className="text-gray-700 font-mono text-[11px]">{guestProfile.phone}</span>
                    </div>
                    <Badge tone="amber" className="h-5 px-2 text-[10px]">
                      {guestProfile.tier || 'BASE'} Tier
                    </Badge>
                  </div>

                  {/* Core Metric Highlights */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-border bg-background p-3 text-xs">
                      <span className="text-gray-700 block">Total Visits</span>
                      <span className="mt-1 text-lg font-bold text-gray-1000 tabular block">
                        {guestProfile.totalVisits}
                      </span>
                    </div>

                    <div className="rounded-lg border border-border bg-background p-3 text-xs">
                      <span className="text-gray-700 block">Lifetime Spend</span>
                      <span className="mt-1 text-lg font-bold text-gray-1000 tabular block">
                        {formatMoney(guestProfile.lifetimeSpendPaise, currency)}
                      </span>
                    </div>
                  </div>

                  {/* The Critical Protection Test: Voids Count */}
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-950/20 p-3.5 text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-emerald-900 dark:text-emerald-300 flex items-center gap-1.5">
                        <CheckCircle2 size={14} className="text-emerald-600" />
                        Attributed Return Strikes
                      </span>
                      <span className="font-mono text-base font-bold text-emerald-700 dark:text-emerald-400">
                        {guestProfile.totalVoidsCount ?? 0} strikes
                      </span>
                    </div>
                    <p className="text-[11px] text-emerald-800 dark:text-emerald-300 leading-relaxed">
                      <strong>Client Guarantee:</strong> Kitchen burns (`KITCHEN`) and server entry errors (`SERVER_ENTRY`)
                      are strictly isolated and never increment this customer strike counter.
                    </p>
                  </div>
                </>
              ) : (
                <div className="py-6 text-center text-xs text-gray-700">
                  <User size={28} className="mx-auto mb-2 text-gray-400" />
                  <p>Select an order with a linked diner profile to inspect their CRM shield metrics.</p>
                </div>
              )}
            </CardBody>
          </Card>

          {/* Audit Log of Recent POS Adjustments */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Clock size={15} className="text-gray-800" />
                Fair Void Audit Log ({adjustments.length})
              </CardTitle>
            </CardHeader>

            <CardBody className="p-0">
              <div className="max-h-80 overflow-y-auto divide-y divide-border">
                {adjustments.length === 0 ? (
                  <div className="py-8 text-center text-xs text-gray-700">
                    No voids recorded yet. Perform an item void to test the classification engine.
                  </div>
                ) : (
                  adjustments.map((a) => {
                    const isProtected = !a.countsAsGuestReturn;
                    return (
                      <div key={a.id} className="p-3 text-xs hover:bg-background-2/40 transition-colors">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <Badge
                              tone={isProtected ? 'green' : 'amber'}
                              className="h-4 px-1.5 text-[9px] uppercase font-semibold"
                            >
                              {a.attributionClass}
                            </Badge>
                            <span className="font-medium text-gray-1000">{a.itemName}</span>
                          </div>
                          <span className="font-semibold text-gray-1000 tabular">
                            {formatMoney(a.amountPaise, currency)}
                          </span>
                        </div>

                        <div className="mt-1 flex items-center justify-between text-[11px] text-gray-700">
                          <span>
                            Reason: <strong>{a.reasonRef}</strong>
                          </span>
                          <span className={cn('font-medium', isProtected ? 'text-success-fg' : 'text-amber-fg')}>
                            {isProtected ? '🛡️ Shielded (0 Penalties)' : '⚠️ Diner Attributed'}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Fair Void Modal */}
      <Dialog
        open={Boolean(voidModalItem)}
        onClose={() => {
          if (!submittingVoid) setVoidModalItem(null);
        }}
        title="Void Item (Fair Attribution Engine)"
        description="Select reason code to classify defect responsibility according to business rule BR-13."
        footer={
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setVoidModalItem(null)}
              disabled={submittingVoid}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={submittingVoid}
              onClick={() => void handleConfirmVoid()}
            >
              Confirm Void
            </Button>
          </div>
        }
      >
        {voidModalItem ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-background-2 p-3 text-xs">
              <span className="text-gray-800 block">Item to Void:</span>
              <span className="font-semibold text-gray-1000 text-sm">{voidModalItem.name}</span>
              <span className="text-gray-800 block mt-0.5 tabular">
                Amount: <strong>{formatMoney(voidModalItem.lineTotalPaise, currency)}</strong>
              </span>
            </div>

            <Field label="Void Reason" htmlFor="pos-void-reason">
              <Select
                id="pos-void-reason"
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value as VoidReason)}
              >
                {VOID_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r.replace(/_/g, ' ')} ({DEFAULT_VOID_REASON_MAPPINGS[r]})
                  </option>
                ))}
              </Select>
            </Field>

            {/* Fair Void CRM Attribution Live Preview Banner */}
            {(() => {
              const attr = DEFAULT_VOID_REASON_MAPPINGS[voidReason] || 'OPERATIONS';
              const isKitchenOrServer = attr === 'KITCHEN' || attr === 'SERVER_ENTRY';
              const isGuest = attr === 'GUEST';

              return (
                <div
                  className={cn(
                    'rounded-lg border p-3 text-xs',
                    isKitchenOrServer
                      ? 'border-success/30 bg-success-soft text-success-fg'
                      : isGuest
                        ? 'border-amber/30 bg-amber-soft text-amber-fg'
                        : 'border-blue/30 bg-blue-soft text-blue-fg',
                  )}
                >
                  <div className="flex items-center gap-2 font-semibold">
                    <Badge
                      tone={isKitchenOrServer ? 'green' : isGuest ? 'amber' : 'blue'}
                      className="h-5 px-1.5 text-[10px]"
                    >
                      {attr}
                    </Badge>
                    <span>
                      {isKitchenOrServer
                        ? 'Diner CRM Profile Shielded (0 Penalties)'
                        : isGuest
                          ? 'Attributed to Guest Return'
                          : 'Operational / Promo Courtesy'}
                    </span>
                  </div>
                  <p className="mt-1.5 leading-relaxed text-[11px]">
                    {isKitchenOrServer
                      ? 'Defect caused by staff or kitchen mistake. The customer profile return counter will NOT be incremented.'
                      : isGuest
                        ? 'Guest preference change after firing. Increments customer return metrics in CRM.'
                        : 'Promotional courtesy comp. Guest profile remains clean.'}
                  </p>
                </div>
              );
            })()}

            <Field label="Authorized By" htmlFor="pos-void-auth">
              <Input
                id="pos-void-auth"
                placeholder="e.g. Floor Manager"
                value={voidAuthorizedBy}
                onChange={(e) => setVoidAuthorizedBy(e.target.value)}
              />
            </Field>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
