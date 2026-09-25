'use client';

import { useState, useEffect, useCallback } from 'react';
import type {
  MenuItemDto,
  OrderDetail,
  OrderStatus,
  SettleResult,
  TenderInput,
} from '@nexora/shared';
import { formatINR, MENU_CATEGORIES, POINTS_PER_RUPEE_UNIT } from '@nexora/shared';
import { adminApi, apiMessage, send } from './admin-api';
import { useConsole } from './console-provider';
import { Badge, Button, Dialog, Field, Input, Select, Sheet, StatusBadge } from '@/components/ui';
import { toast } from 'sonner';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CreditCard,
  DollarSign,
  Gift,
  Plus,
  Receipt,
  Sparkles,
  Trash2,
  Utensils,
  Wallet,
} from 'lucide-react';
import { cn } from '@/lib/cn';

interface OrderDrawerProps {
  open: boolean;
  onClose: () => void;
  orderId: string | null;
  venueId: string;
  onOrderUpdated?: () => void;
}

export function OrderDrawer({
  open,
  onClose,
  orderId,
  venueId,
  onOrderUpdated,
}: OrderDrawerProps) {
  const { emit } = useConsole();

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Menu items for add-item picker
  const [menuItems, setMenuItems] = useState<MenuItemDto[]>([]);

  // Add Item Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [addMode, setAddMode] = useState<'menu' | 'custom'>('menu');
  const [selectedMenuItemId, setSelectedMenuItemId] = useState<string>('');
  const [customItemName, setCustomItemName] = useState<string>('');
  const [customCategory, setCustomCategory] = useState<string>('STARTER');
  const [customPriceRupees, setCustomPriceRupees] = useState<string>('');
  const [itemQuantity, setItemQuantity] = useState<number>(1);
  const [itemNotes, setItemNotes] = useState<string>('');

  // Settlement Dialog State
  const [settleDialogOpen, setSettleDialogOpen] = useState(false);
  const [tenders, setTenders] = useState<TenderInput[]>([]);
  const [simulateCardDecline, setSimulateCardDecline] = useState(false);
  const [simulateGiftTimeout, setSimulateGiftTimeout] = useState(false);
  const [giftCardNumber, setGiftCardNumber] = useState('GC-9900-1122');
  const [settleError, setSettleError] = useState<string | null>(null);

  // Load Order Details
  const loadOrder = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<OrderDetail>(`/admin/orders/${orderId}`);
      setOrder(data);
    } catch (e) {
      setError(apiMessage(e));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  // Load Menu items for adding items
  useEffect(() => {
    if (!open || !venueId) return;
    adminApi<MenuItemDto[]>(`/admin/venues/${venueId}/menu`)
      .then((items) => {
        setMenuItems(items);
        if (items.length > 0 && !selectedMenuItemId) {
          setSelectedMenuItemId(items[0].id);
        }
      })
      .catch(() => undefined);
  }, [open, venueId, selectedMenuItemId]);

  useEffect(() => {
    if (open && orderId) {
      void loadOrder();
      setShowAddForm(false);
      setSettleDialogOpen(false);
    } else {
      setOrder(null);
    }
  }, [open, orderId, loadOrder]);

  // KDS Status Transition
  async function handleAdvanceStatus(nextStatus: OrderStatus) {
    if (!order) return;
    setActionLoading(`status-${nextStatus}`);
    try {
      const updated = await send<OrderDetail>('POST', `/admin/orders/${order.id}/status`, {
        status: nextStatus,
      });
      setOrder(updated);
      toast.success(`Order advanced to ${nextStatus}`);
      emit('order:changed');
      emit('floor:changed');
      onOrderUpdated?.();
    } catch (e) {
      toast.error('Failed to advance order status', { description: apiMessage(e) });
    } finally {
      setActionLoading(null);
    }
  }

  // Add Item to Check
  async function handleAddItem(e: React.FormEvent) {
    e.preventDefault();
    if (!order) return;
    setActionLoading('add-item');
    setError(null);

    try {
      let payload: {
        menuItemId?: string;
        itemName: string;
        category: (typeof MENU_CATEGORIES)[number];
        quantity: number;
        unitPricePaise: number;
        notes?: string;
      };

      if (addMode === 'menu') {
        const item = menuItems.find((m) => m.id === selectedMenuItemId);
        if (!item) {
          setError('Please select a menu item');
          setActionLoading(null);
          return;
        }
        payload = {
          menuItemId: item.id,
          itemName: item.name,
          category: item.category as (typeof MENU_CATEGORIES)[number],
          quantity: itemQuantity,
          unitPricePaise: item.pricePaise,
          notes: itemNotes.trim() || undefined,
        };
      } else {
        const paise = Math.round(Number(customPriceRupees) * 100);
        if (!customItemName.trim() || !Number.isFinite(paise) || paise <= 0) {
          setError('Enter valid custom item name and price');
          setActionLoading(null);
          return;
        }
        payload = {
          itemName: customItemName.trim(),
          category: customCategory as (typeof MENU_CATEGORIES)[number],
          quantity: itemQuantity,
          unitPricePaise: paise,
          notes: itemNotes.trim() || undefined,
        };
      }

      const updated = await send<OrderDetail>('POST', `/admin/orders/${order.id}/items`, payload);
      setOrder(updated);
      toast.success('Item added to check');
      setShowAddForm(false);
      setItemNotes('');
      setItemQuantity(1);
      emit('order:changed');
      emit('floor:changed');
      onOrderUpdated?.();
    } catch (e) {
      setError(apiMessage(e));
    } finally {
      setActionLoading(null);
    }
  }

  // Delete Item from Check
  async function handleDeleteItem(itemId: string) {
    if (!order) return;
    setActionLoading(`del-${itemId}`);
    try {
      const updated = await send<OrderDetail>('DELETE', `/admin/orders/${order.id}/items/${itemId}`);
      setOrder(updated);
      toast.success('Item removed from check');
      emit('order:changed');
      emit('floor:changed');
      onOrderUpdated?.();
    } catch (e) {
      toast.error('Failed to remove item', { description: apiMessage(e) });
    } finally {
      setActionLoading(null);
    }
  }

  // Open Settle Dialog
  function openSettlement() {
    if (!order) return;
    const remainingPaise = Math.max(0, order.netPaise - order.paidPaise);
    setTenders([{ type: 'CARD', amountPaise: remainingPaise, simulateDecline: false }]);
    setSettleError(null);
    setSimulateCardDecline(false);
    setSimulateGiftTimeout(false);
    setSettleDialogOpen(true);
  }

  // Split-Tender Helpers
  const remainingFolioPaise = order
    ? Math.max(
        0,
        order.netPaise -
          order.paidPaise -
          tenders.reduce((sum, t) => {
            if (t.type === 'POINTS') return sum + Math.round((t.points * 100) / POINTS_PER_RUPEE_UNIT);
            return sum + t.amountPaise;
          }, 0),
      )
    : 0;

  function addTender(type: 'CASH' | 'CARD' | 'GIFT_CARD' | 'POINTS' | 'WALLET') {
    const amount = remainingFolioPaise > 0 ? remainingFolioPaise : 0;
    if (type === 'GIFT_CARD') {
      setTenders((prev) => [
        ...prev,
        { type: 'GIFT_CARD', amountPaise: amount, cardNumber: giftCardNumber, simulateTimeout: simulateGiftTimeout },
      ]);
    } else if (type === 'POINTS') {
      const points = Math.ceil((amount * POINTS_PER_RUPEE_UNIT) / 100);
      setTenders((prev) => [...prev, { type: 'POINTS', points: Math.max(100, points) }]);
    } else if (type === 'CARD') {
      setTenders((prev) => [...prev, { type: 'CARD', amountPaise: amount, simulateDecline: simulateCardDecline }]);
    } else {
      setTenders((prev) => [...prev, { type, amountPaise: amount }]);
    }
  }

  function updateTenderAmount(index: number, paise: number) {
    setTenders((prev) =>
      prev.map((t, i) => {
        if (i !== index) return t;
        if (t.type === 'POINTS') {
          return { ...t, points: Math.ceil((paise * POINTS_PER_RUPEE_UNIT) / 100) };
        }
        return { ...t, amountPaise: Math.max(0, paise) };
      }),
    );
  }

  function removeTender(index: number) {
    setTenders((prev) => prev.filter((_, i) => i !== index));
  }

  // Settle Order Submit
  async function handleSettleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!order) return;
    setActionLoading('settle');
    setSettleError(null);

    // Apply simulation flags to tenders
    const finalTenders = tenders.map((t) => {
      if (t.type === 'CARD') return { ...t, simulateDecline: simulateCardDecline };
      if (t.type === 'GIFT_CARD') return { ...t, simulateTimeout: simulateGiftTimeout, cardNumber: giftCardNumber };
      return t;
    });

    try {
      const result = await send<SettleResult>('POST', `/admin/orders/${order.id}/settle`, {
        tenders: finalTenders,
      });

      setOrder(result.order);
      emit('order:changed');
      emit('floor:changed');
      onOrderUpdated?.();

      if (result.outcome === 'BILLED') {
        toast.success('Order fully settled and billed!', {
          description: result.pointsEarned ? `Awarded ${result.pointsEarned} loyalty points.` : undefined,
        });
        setSettleDialogOpen(false);
      } else {
        // Partially paid outcome
        setSettleError(result.message || 'Folio remains partially paid.');
        toast.warning('Tender partially processed', { description: result.message ?? undefined });
      }
    } catch (err) {
      setSettleError(apiMessage(err));
    } finally {
      setActionLoading(null);
    }
  }

  const isOpenForItems = order && !['BILLED', 'VOIDED', 'PARTIALLY_PAID'].includes(order.status);
  const remainingTotalPaise = order ? Math.max(0, order.netPaise - order.paidPaise) : 0;

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title={
          <div className="flex items-center gap-2">
            <span>Table {order?.tableNumber ?? '...'}</span>
            {order ? <StatusBadge status={order.status} className="text-[11px]" /> : null}
          </div>
        }
        description={
          order
            ? `${order.guestName ? `Guest: ${order.guestName} · ` : ''}Check #${order.id.slice(0, 8)}`
            : 'Loading check details…'
        }
        footer={
          order && !['BILLED', 'VOIDED'].includes(order.status) ? (
            <div className="flex w-full items-center justify-between">
              <div className="text-xs">
                <span className="text-gray-800">Remaining Folio: </span>
                <span className="font-semibold text-gray-1000 tabular">{formatINR(remainingTotalPaise)}</span>
              </div>
              <Button variant="primary" size="sm" onClick={openSettlement}>
                <Receipt size={14} className="mr-1.5" />
                Settle & Bill Folio
              </Button>
            </div>
          ) : undefined
        }
      >
        {loading && !order ? (
          <div className="py-12 text-center text-xs text-gray-800">Loading order items…</div>
        ) : error ? (
          <div className="rounded-lg border border-red/20 bg-red-soft p-3 text-xs text-red-fg">{error}</div>
        ) : order ? (
          <div className="space-y-5 pb-6">
            {/* KDS Progression Bar */}
            <div className="rounded-xl border border-border bg-background p-3.5 shadow-sm">
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="font-semibold text-gray-1000">Kitchen & Service Status</span>
                <span className="text-gray-800 tabular text-[11px]">
                  Placed at {new Date(order.placedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              <div className="flex items-center gap-1.5 pt-1">
                {order.status === 'PLACED' && (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={actionLoading === 'status-RECEIVED'}
                    onClick={() => handleAdvanceStatus('RECEIVED')}
                    className="w-full text-xs"
                  >
                    <span>Receive in Kitchen</span>
                    <ArrowRight size={13} className="ml-1" />
                  </Button>
                )}

                {order.status === 'RECEIVED' && (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={actionLoading === 'status-PREPARING'}
                    onClick={() => handleAdvanceStatus('PREPARING')}
                    className="w-full text-xs"
                  >
                    <span>Start Preparation</span>
                    <ArrowRight size={13} className="ml-1" />
                  </Button>
                )}

                {order.status === 'PREPARING' && (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={actionLoading === 'status-SERVED'}
                    onClick={() => handleAdvanceStatus('SERVED')}
                    className="w-full text-xs"
                  >
                    <span>Mark as Served</span>
                    <Check size={13} className="ml-1" />
                  </Button>
                )}

                {order.status === 'SERVED' && (
                  <div className="flex w-full items-center justify-between rounded-lg bg-success-soft px-3 py-2 text-xs text-success-fg">
                    <span className="font-medium">All items served to guest</span>
                    <Button variant="secondary" size="sm" onClick={openSettlement} className="h-7 text-xs">
                      Settle Order
                    </Button>
                  </div>
                )}

                {order.status === 'BILLED' && (
                  <div className="flex w-full items-center justify-center rounded-lg bg-gray-100 py-2 text-xs font-medium text-gray-1000">
                    <Check size={14} className="mr-1 text-success-fg" /> Order Billed & Settled
                  </div>
                )}

                {order.status === 'PARTIALLY_PAID' && (
                  <div className="flex w-full items-center justify-between rounded-lg bg-amber-soft px-3 py-2 text-xs text-amber-fg">
                    <span className="font-medium">Partially Paid ({formatINR(remainingTotalPaise)} remaining)</span>
                    <Button variant="secondary" size="sm" onClick={openSettlement} className="h-7 text-xs">
                      Resume Settle
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* Items List */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-900">
                  Order Items ({order.items.length})
                </h4>
                {isOpenForItems && !showAddForm && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowAddForm(true)}
                    className="h-7 px-2 text-xs"
                  >
                    <Plus size={13} className="mr-1" /> Add Item
                  </Button>
                )}
              </div>

              {/* Add Item Form Collapse */}
              {showAddForm && (
                <div className="mb-4 rounded-xl border border-border bg-background p-3.5 shadow-sm space-y-3 animate-fade-in">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-1000">Add Item to Check</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setAddMode('menu')}
                        className={cn(
                          'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                          addMode === 'menu' ? 'bg-gray-1000 text-white' : 'text-gray-800 hover:bg-gray-100',
                        )}
                      >
                        Menu Item
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddMode('custom')}
                        className={cn(
                          'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                          addMode === 'custom' ? 'bg-gray-1000 text-white' : 'text-gray-800 hover:bg-gray-100',
                        )}
                      >
                        Custom Item
                      </button>
                    </div>
                  </div>

                  <form onSubmit={handleAddItem} className="space-y-3">
                    {addMode === 'menu' ? (
                      <Field label="Select from Menu" htmlFor="menu-picker">
                        <Select
                          id="menu-picker"
                          value={selectedMenuItemId}
                          onChange={(e) => setSelectedMenuItemId(e.target.value)}
                        >
                          {menuItems.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} ({m.category}) - {formatINR(m.pricePaise)}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Item Name" htmlFor="custom-item-name">
                          <Input
                            id="custom-item-name"
                            placeholder="e.g. Masala Chai"
                            value={customItemName}
                            onChange={(e) => setCustomItemName(e.target.value)}
                            required
                          />
                        </Field>
                        <Field label="Price (₹)" htmlFor="custom-item-price">
                          <Input
                            id="custom-item-price"
                            type="number"
                            step="0.01"
                            placeholder="e.g. 150"
                            value={customPriceRupees}
                            onChange={(e) => setCustomPriceRupees(e.target.value)}
                            required
                          />
                        </Field>
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-2">
                      <Field label="Quantity" htmlFor="item-qty">
                        <Select
                          id="item-qty"
                          value={itemQuantity}
                          onChange={(e) => setItemQuantity(Number(e.target.value))}
                        >
                          {[1, 2, 3, 4, 5, 6, 8, 10].map((q) => (
                            <option key={q} value={q}>
                              {q}
                            </option>
                          ))}
                        </Select>
                      </Field>

                      <div className="col-span-2">
                        <Field label="Special Requests / Notes" htmlFor="item-notes">
                          <Input
                            id="item-notes"
                            placeholder="e.g. No onions, less ice"
                            value={itemNotes}
                            onChange={(e) => setItemNotes(e.target.value)}
                          />
                        </Field>
                      </div>
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowAddForm(false)}
                        className="text-xs"
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        loading={actionLoading === 'add-item'}
                        className="text-xs"
                      >
                        Add to Check
                      </Button>
                    </div>
                  </form>
                </div>
              )}

              {/* Items Card List */}
              <div className="rounded-xl border border-border bg-background divide-y divide-border overflow-hidden">
                {order.items.length === 0 ? (
                  <div className="py-8 text-center text-xs text-gray-700">No items added to this order yet.</div>
                ) : (
                  order.items.map((item) => (
                    <div key={item.id} className="flex items-center justify-between p-3 text-xs">
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="flex items-center gap-2">
                          <span className={cn('font-medium text-gray-1000', item.isVoided && 'line-through text-gray-700')}>
                            {item.quantity}× {item.itemName}
                          </span>
                          <span className="rounded bg-gray-100 px-1.5 py-0.2 text-[10px] uppercase text-gray-800">
                            {item.category}
                          </span>
                          {item.isVoided && (
                            <Badge tone="red" className="h-4 px-1 text-[9px]">
                              Voided
                            </Badge>
                          )}
                        </div>
                        {item.notes ? (
                          <div className="mt-0.5 text-[11px] text-gray-800 italic">“{item.notes}”</div>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className={cn('font-semibold text-gray-1000 tabular', item.isVoided && 'line-through text-gray-700')}>
                            {formatINR(item.lineTotalPaise)}
                          </div>
                          {item.quantity > 1 && (
                            <div className="text-[10px] text-gray-800 tabular">
                              {formatINR(item.unitPricePaise)} ea
                            </div>
                          )}
                        </div>

                        {order.status === 'PLACED' && !item.isVoided && (
                          <button
                            type="button"
                            onClick={() => void handleDeleteItem(item.id)}
                            disabled={actionLoading === `del-${item.id}`}
                            className="rounded p-1 text-gray-700 hover:text-red hover:bg-red-soft transition-colors"
                            title="Remove item"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Totals Summary */}
            <div className="rounded-xl border border-border bg-background p-4 shadow-sm space-y-2 text-xs">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-900 pb-1 border-b border-border">
                Folio Breakdown
              </h4>
              <div className="flex justify-between text-gray-800">
                <span>Gross Total</span>
                <span className="tabular font-medium text-gray-1000">{formatINR(order.grossPaise)}</span>
              </div>
              {order.discountPaise > 0 ? (
                <div className="flex justify-between text-success-fg">
                  <span>Discounts & Voids</span>
                  <span className="tabular font-medium">-{formatINR(order.discountPaise)}</span>
                </div>
              ) : null}
              <div className="flex justify-between text-gray-800 pt-1 border-t border-border">
                <span className="font-semibold text-gray-1000">Net Total</span>
                <span className="tabular font-bold text-gray-1000">{formatINR(order.netPaise)}</span>
              </div>
              {order.paidPaise > 0 ? (
                <div className="flex justify-between text-blue-fg">
                  <span>Paid so far</span>
                  <span className="tabular font-semibold">{formatINR(order.paidPaise)}</span>
                </div>
              ) : null}
              <div className="flex justify-between items-center pt-2 border-t border-border text-sm">
                <span className="font-bold text-gray-1000">Balance Due</span>
                <span className="tabular font-bold text-base text-gray-1000">
                  {formatINR(remainingTotalPaise)}
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </Sheet>

      {/* Split-Tender Settlement Dialog */}
      <Dialog
        open={settleDialogOpen}
        onClose={() => setSettleDialogOpen(false)}
        title="Settle Order & Split Tender"
        description="Allocate amounts across tender methods to close the table folio."
      >
        <form onSubmit={handleSettleSubmit} className="space-y-4">
          {settleError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red/20 bg-red-soft p-3 text-xs text-red-fg"
            >
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <div className="leading-relaxed">{settleError}</div>
            </div>
          ) : null}

          {/* Quick Balance Header */}
          <div className="flex items-center justify-between rounded-lg bg-background-2 border border-border p-3">
            <div>
              <span className="text-[11px] text-gray-800 uppercase font-medium">Total Balance Due</span>
              <div className="text-base font-bold text-gray-1000 tabular">{formatINR(remainingTotalPaise)}</div>
            </div>
            <div className="text-right">
              <span className="text-[11px] text-gray-800 uppercase font-medium">Unallocated Folio</span>
              <div
                className={cn(
                  'text-base font-bold tabular',
                  remainingFolioPaise === 0
                    ? 'text-success-fg'
                    : remainingFolioPaise > 0
                      ? 'text-amber-fg'
                      : 'text-red-fg',
                )}
              >
                {formatINR(remainingFolioPaise)}
              </div>
            </div>
          </div>

          {/* Add Tender Buttons */}
          <div>
            <label className="text-[12px] font-medium text-gray-900 block mb-1.5">Add Tender Method</label>
            <div className="grid grid-cols-3 gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => addTender('CARD')}
                className="text-xs"
              >
                <CreditCard size={12} className="mr-1" /> + Card
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => addTender('CASH')}
                className="text-xs"
              >
                <DollarSign size={12} className="mr-1" /> + Cash
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => addTender('GIFT_CARD')}
                className="text-xs"
              >
                <Gift size={12} className="mr-1" /> + Gift Card
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => addTender('POINTS')}
                className="text-xs"
              >
                <Sparkles size={12} className="mr-1" /> + Points
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => addTender('WALLET')}
                className="text-xs"
              >
                <Wallet size={12} className="mr-1" /> + Wallet
              </Button>
            </div>
          </div>

          {/* Tender Rows */}
          <div className="space-y-2">
            <label className="text-[12px] font-medium text-gray-900 block">Tenders to Capture</label>
            {tenders.length === 0 ? (
              <div className="py-4 text-center text-xs text-gray-800">
                No tenders added. Click a tender method above.
              </div>
            ) : (
              tenders.map((tender, idx) => {
                const amountRupees =
                  tender.type === 'POINTS'
                    ? (tender.points * 100) / POINTS_PER_RUPEE_UNIT / 100
                    : tender.amountPaise / 100;

                return (
                  <div
                    key={idx}
                    className="flex items-center gap-2 rounded-lg border border-border bg-background p-2.5 text-xs"
                  >
                    <Badge tone="neutral" className="w-24 justify-center text-[10px] uppercase font-semibold">
                      {tender.type}
                    </Badge>

                    <div className="relative flex-1">
                      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-800 text-xs">
                        {tender.type === 'POINTS' ? 'Pts' : '₹'}
                      </span>
                      <Input
                        type="number"
                        min="1"
                        value={tender.type === 'POINTS' ? tender.points : amountRupees}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          if (tender.type === 'POINTS') {
                            setTenders((prev) =>
                              prev.map((t, i) => (i === idx ? { ...t, points: Math.max(0, val) } : t)),
                            );
                          } else {
                            updateTenderAmount(idx, Math.round(val * 100));
                          }
                        }}
                        className="h-8 pl-7 text-xs tabular"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => removeTender(idx)}
                      className="rounded p-1 text-gray-700 hover:text-red"
                      title="Remove tender"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Tender Simulations & Parameters */}
          <div className="rounded-lg border border-border bg-background-2 p-3 text-xs space-y-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-800 block">
              POS Edge Case Simulations
            </span>

            <label className="flex items-center gap-2 cursor-pointer text-gray-1000 select-none">
              <input
                type="checkbox"
                checked={simulateCardDecline}
                onChange={(e) => setSimulateCardDecline(e.target.checked)}
                className="rounded border-gray-300 text-gray-1000 focus:ring-gray-1000"
              />
              <span>Simulate Card Decline (External Gateway Error)</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-gray-1000 select-none">
              <input
                type="checkbox"
                checked={simulateGiftTimeout}
                onChange={(e) => setSimulateGiftTimeout(e.target.checked)}
                className="rounded border-gray-300 text-gray-1000 focus:ring-gray-1000"
              />
              <span>Simulate Gift Card Timeout (Leaves Folio PARTIALLY_PAID)</span>
            </label>

            {tenders.some((t) => t.type === 'GIFT_CARD') && (
              <div className="pt-1">
                <Field label="Gift Card Number" htmlFor="gc-number">
                  <Input
                    id="gc-number"
                    value={giftCardNumber}
                    onChange={(e) => setGiftCardNumber(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                </Field>
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setSettleDialogOpen(false)}
              disabled={actionLoading === 'settle'}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={actionLoading === 'settle'}
              disabled={tenders.length === 0}
            >
              Capture & Settle
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
