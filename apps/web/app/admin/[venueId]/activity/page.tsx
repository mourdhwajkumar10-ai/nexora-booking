'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Code2,
  Copy,
  Eye,
  FileText,
  Filter,
  Layers,
  MessageSquare,
  Play,
  Radio,
  RefreshCw,
  RotateCw,
  Send,
  Server,
  Shield,
  Smartphone,
  Terminal,
  Webhook,
  X,
  XCircle,
} from 'lucide-react';
import { z } from 'zod';
import type {
  AuditLogDto,
  NotificationDto,
  PosEventType,
  WebhookEventDto,
} from '@nexora/shared';
import { PosSimulateInput, VOID_REASONS, MENU_CATEGORIES } from '@nexora/shared';
import { adminApi, apiMessage, rupeesToPaise, send } from '@/components/admin/admin-api';
import { useConsole } from '@/components/admin/console-provider';
import { formatDateTime, formatINR } from '@/lib/format';
import {
  Badge,
  BadgeTone,
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
  Textarea,
} from '@/components/ui';

type Tab = 'NOTIFICATIONS' | 'WEBHOOKS' | 'SIMULATOR' | 'AUDIT';

export default function ActivityPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = React.use(params);
  const { isManager, subscribe, emit } = useConsole();

  const [activeTab, setActiveTab] = useState<Tab>('NOTIFICATIONS');

  // Notifications State
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [loadingNotifications, setLoadingNotifications] = useState(false);

  // Webhooks State
  const [webhooks, setWebhooks] = useState<WebhookEventDto[]>([]);
  const [loadingWebhooks, setLoadingWebhooks] = useState(false);
  const [webhookFilter, setWebhookFilter] = useState<'ALL' | 'DEAD' | 'FAILED' | 'PROCESSED'>('ALL');
  const [replayingId, setReplayingId] = useState<string | null>(null);

  // Audit State
  const [auditLogs, setAuditLogs] = useState<AuditLogDto[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [inspectAuditItem, setInspectAuditItem] = useState<AuditLogDto | null>(null);

  // Simulator State
  const [simEventType, setSimEventType] = useState<PosEventType>('ticket.updated');
  const [simOrderId, setSimOrderId] = useState('00000000-0000-0000-0000-000000000001');
  const [simIdempotencyKey, setSimIdempotencyKey] = useState('');
  const [simFailTimes, setSimFailTimes] = useState(0);
  const [simItemName, setSimItemName] = useState('Truffle Rigatoni');
  const [simItemCategory, setSimItemCategory] = useState<string>('ENTREE');
  const [simItemQty, setSimItemQty] = useState(2);
  const [simItemPriceRupees, setSimItemPriceRupees] = useState('850');
  const [simVoidReason, setSimVoidReason] = useState<string>('GUEST_REJECTED');
  const [simCompAmountRupees, setSimCompAmountRupees] = useState('500');
  const [simAuthorizedBy, setSimAuthorizedBy] = useState('Floor Manager');
  const [simResult, setSimResult] = useState<any>(null);
  const [simulating, setSimulating] = useState(false);

  // Load Notifications
  const loadNotifications = useCallback(async () => {
    setLoadingNotifications(true);
    try {
      const data = await adminApi<NotificationDto[]>(`/admin/venues/${venueId}/notifications`);
      setNotifications(data);
    } catch (e) {
      toast.error('Could not load notifications', { description: apiMessage(e) });
    } finally {
      setLoadingNotifications(false);
    }
  }, [venueId]);

  // Load Webhooks
  const loadWebhooks = useCallback(async () => {
    setLoadingWebhooks(true);
    try {
      const data = await adminApi<WebhookEventDto[]>(`/admin/venues/${venueId}/webhooks`);
      setWebhooks(data);
    } catch (e) {
      toast.error('Could not load POS webhooks', { description: apiMessage(e) });
    } finally {
      setLoadingWebhooks(false);
    }
  }, [venueId]);

  // Load Audit
  const loadAudit = useCallback(async () => {
    setLoadingAudit(true);
    try {
      const data = await adminApi<AuditLogDto[]>(`/admin/venues/${venueId}/audit`);
      setAuditLogs(data);
    } catch (e) {
      // Host may not have access if manager-only
    } finally {
      setLoadingAudit(false);
    }
  }, [venueId]);

  useEffect(() => {
    if (activeTab === 'NOTIFICATIONS') void loadNotifications();
    else if (activeTab === 'WEBHOOKS') void loadWebhooks();
    else if (activeTab === 'AUDIT') void loadAudit();
  }, [activeTab, loadNotifications, loadWebhooks, loadAudit]);

  // Subscribe to realtime notifications and polling
  useEffect(() => {
    return subscribe(['notification:sent', 'poll'], () => {
      if (activeTab === 'NOTIFICATIONS') void loadNotifications();
      if (activeTab === 'WEBHOOKS') void loadWebhooks();
    });
  }, [subscribe, activeTab, loadNotifications, loadWebhooks]);

  // Replay Webhook Event
  const handleReplay = async (event: WebhookEventDto) => {
    setReplayingId(event.id);
    try {
      const replayed = await send<WebhookEventDto>('POST', `/admin/webhooks/${event.id}/replay`);
      toast.success(`Event ${replayed.eventType} replayed`, {
        description: `Status: ${replayed.status}. Attempts: ${replayed.attempts}`,
      });
      void loadWebhooks();
      emit('order:changed');
    } catch (e) {
      toast.error('Replay failed', { description: apiMessage(e) });
    } finally {
      setReplayingId(null);
    }
  };

  // Run POS Simulator
  const handleSimulate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSimulating(true);
    setSimResult(null);

    try {
      const eventId = `sim-evt-${Date.now()}`;
      let body: any;

      if (simEventType === 'ticket.updated') {
        const pricePaise = rupeesToPaise(simItemPriceRupees) || 50000;
        body = {
          type: 'ticket.updated',
          eventId,
          orderId: simOrderId,
          items: [
            {
              itemName: simItemName.trim() || 'Menu Item',
              category: simItemCategory,
              quantity: Number(simItemQty) || 1,
              unitPricePaise: pricePaise,
            },
          ],
        };
      } else if (simEventType === 'order.item_voided') {
        body = {
          type: 'order.item_voided',
          eventId,
          orderId: simOrderId,
          orderItemId: '00000000-0000-0000-0000-000000000002',
          reason: simVoidReason,
          authorizedBy: simAuthorizedBy.trim() || 'Floor Manager',
        };
      } else if (simEventType === 'order.comp_applied') {
        body = {
          type: 'order.comp_applied',
          eventId,
          orderId: simOrderId,
          amountPaise: rupeesToPaise(simCompAmountRupees) || 10000,
          reason: simVoidReason,
          authorizedBy: simAuthorizedBy.trim() || 'Floor Manager',
        };
      } else if (simEventType === 'order.refunded') {
        body = {
          type: 'order.refunded',
          eventId,
          orderId: simOrderId,
          orderItemId: '00000000-0000-0000-0000-000000000002',
          reason: simVoidReason,
          authorizedBy: simAuthorizedBy.trim() || 'Floor Manager',
        };
      }

      const payload: z.infer<typeof PosSimulateInput> = {
        body,
        idempotencyKey: simIdempotencyKey.trim() || undefined,
        failTimes: Number(simFailTimes) || 0,
      };

      const res = await send<any>('POST', `/admin/venues/${venueId}/pos/simulate`, payload);
      setSimResult(res);
      toast.success('Simulation executed successfully', {
        description: `Status: ${res.status || 'Processed'}`,
      });
      emit('order:changed');
    } catch (err) {
      toast.error('Simulation failed', { description: apiMessage(err) });
      setSimResult({ error: apiMessage(err) });
    } finally {
      setSimulating(false);
    }
  };

  const filteredWebhooks = webhooks.filter((w) => {
    if (webhookFilter === 'ALL') return true;
    return w.status === webhookFilter;
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 space-y-8">
      {/* Top Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-1000">Activity & Telemetry</h1>
          <p className="mt-1 text-sm text-gray-800">
            Outbox notification history, POS webhook ingestion and DLQ replay, test harness, and security audit logs.
          </p>
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            if (activeTab === 'NOTIFICATIONS') void loadNotifications();
            else if (activeTab === 'WEBHOOKS') void loadWebhooks();
            else if (activeTab === 'AUDIT') void loadAudit();
          }}
          className="gap-1.5"
        >
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>

      {/* Tabs Control */}
      <div className="flex border-b border-border">
        <nav className="-mb-px flex space-x-6 text-sm font-medium">
          <button
            type="button"
            onClick={() => setActiveTab('NOTIFICATIONS')}
            className={`flex items-center gap-2 border-b-2 pb-3.5 transition-colors ${
              activeTab === 'NOTIFICATIONS'
                ? 'border-gray-1000 text-gray-1000 font-semibold'
                : 'border-transparent text-gray-800 hover:border-border-strong hover:text-gray-1000'
            }`}
          >
            <MessageSquare size={16} />
            <span>Notifications Outbox</span>
            <Badge tone="neutral" className="tabular text-[10px] h-4 px-1.5">
              {notifications.length}
            </Badge>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('WEBHOOKS')}
            className={`flex items-center gap-2 border-b-2 pb-3.5 transition-colors ${
              activeTab === 'WEBHOOKS'
                ? 'border-gray-1000 text-gray-1000 font-semibold'
                : 'border-transparent text-gray-800 hover:border-border-strong hover:text-gray-1000'
            }`}
          >
            <Webhook size={16} />
            <span>POS Webhooks & DLQ</span>
            {webhooks.some((w) => w.status === 'DEAD' || w.status === 'FAILED') ? (
              <Badge tone="red" dot className="tabular text-[10px] h-4 px-1.5">
                {webhooks.filter((w) => w.status === 'DEAD' || w.status === 'FAILED').length} Alert
              </Badge>
            ) : null}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('SIMULATOR')}
            className={`flex items-center gap-2 border-b-2 pb-3.5 transition-colors ${
              activeTab === 'SIMULATOR'
                ? 'border-gray-1000 text-gray-1000 font-semibold'
                : 'border-transparent text-gray-800 hover:border-border-strong hover:text-gray-1000'
            }`}
          >
            <Radio size={16} />
            <span>POS Webhook Simulator</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('AUDIT')}
            className={`flex items-center gap-2 border-b-2 pb-3.5 transition-colors ${
              activeTab === 'AUDIT'
                ? 'border-gray-1000 text-gray-1000 font-semibold'
                : 'border-transparent text-gray-800 hover:border-border-strong hover:text-gray-1000'
            }`}
          >
            <Shield size={16} />
            <span>Audit Trail</span>
          </button>
        </nav>
      </div>

      {/* TAB 1: NOTIFICATIONS OUTBOX */}
      {activeTab === 'NOTIFICATIONS' && (
        <div className="space-y-4">
          {loadingNotifications && notifications.length === 0 ? (
            <Card className="p-6">
              <div className="space-y-4">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex justify-between border-b border-border pb-3">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                ))}
              </div>
            </Card>
          ) : notifications.length === 0 ? (
            <EmptyState
              icon={<MessageSquare size={36} className="text-gray-700" />}
              title="No notifications recorded"
              description="Guest notifications sent via Twilio SMS or Meta WhatsApp Cloud API will be logged here."
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border bg-background-2 text-gray-800 font-medium">
                      <th className="px-5 py-3">Channel & Time</th>
                      <th className="px-4 py-3">Recipient</th>
                      <th className="px-4 py-3">Template</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-5 py-3">Message Body</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {notifications.map((n) => (
                      <tr key={n.id} className="hover:bg-background-2/50 transition-colors">
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <Badge
                              tone={n.channel === 'WHATSAPP' ? 'green' : 'blue'}
                              className="font-mono text-[10px] h-5 px-2"
                            >
                              {n.channel}
                            </Badge>
                            <span className="text-gray-700 tabular">
                              {formatDateTime(n.createdAt)}
                            </span>
                          </div>
                        </td>

                        <td className="px-4 py-3.5 whitespace-nowrap font-medium text-gray-1000 tabular">
                          {n.to}
                        </td>

                        <td className="px-4 py-3.5 whitespace-nowrap font-mono text-gray-800">
                          {n.template}
                        </td>

                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <Badge
                            tone={
                              n.status === 'SENT'
                                ? 'green'
                                : n.status === 'FAILED'
                                ? 'red'
                                : 'amber'
                            }
                            dot
                            className="text-[11px]"
                          >
                            {n.status}
                          </Badge>
                        </td>

                        <td className="px-5 py-3.5 text-gray-900 max-w-md truncate">
                          {n.body}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: WEBHOOK EVENTS & DLQ */}
      {activeTab === 'WEBHOOKS' && (
        <div className="space-y-4">
          {/* Status Filter Toolbar */}
          <div className="flex items-center justify-between">
            <div className="inline-flex rounded-lg border border-border bg-background-2 p-0.5 text-xs font-medium">
              {(['ALL', 'DEAD', 'FAILED', 'PROCESSED'] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setWebhookFilter(filter)}
                  className={`rounded-md px-3 py-1 transition-colors ${
                    webhookFilter === filter
                      ? 'bg-background text-gray-1000 shadow-sm ring-1 ring-border font-semibold'
                      : 'text-gray-800 hover:text-gray-1000'
                  }`}
                >
                  {filter}
                </button>
              ))}
            </div>

            <span className="text-xs text-gray-700 tabular">
              Showing {filteredWebhooks.length} of {webhooks.length} events
            </span>
          </div>

          {loadingWebhooks && webhooks.length === 0 ? (
            <Card className="p-6">
              <Skeleton className="h-40 w-full" />
            </Card>
          ) : filteredWebhooks.length === 0 ? (
            <EmptyState
              icon={<Webhook size={36} className="text-gray-700" />}
              title="No webhook events matching filter"
              description="POS webhook deliveries (signed via HMAC-SHA256) will be logged here."
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border bg-background-2 text-gray-800 font-medium">
                      <th className="px-4 py-3">Event Type</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Attempts</th>
                      <th className="px-4 py-3">Next Retry / Processed</th>
                      <th className="px-4 py-3">Idempotency Key</th>
                      <th className="px-4 py-3">Error / Diagnostics</th>
                      <th className="px-4 py-3 text-right">DLQ Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredWebhooks.map((w) => {
                      const isDead = w.status === 'DEAD';
                      const isFailed = w.status === 'FAILED';

                      return (
                        <tr
                          key={w.id}
                          className={`hover:bg-background-2/50 transition-colors ${
                            isDead ? 'bg-red-soft/20' : ''
                          }`}
                        >
                          <td className="px-4 py-3.5 whitespace-nowrap font-mono font-medium text-gray-1000">
                            {w.eventType}
                          </td>

                          <td className="px-4 py-3.5 whitespace-nowrap">
                            <Badge
                              tone={
                                w.status === 'PROCESSED'
                                ? 'green'
                                : w.status === 'DEAD'
                                ? 'red'
                                : w.status === 'FAILED'
                                ? 'amber'
                                : 'neutral'
                              }
                              dot
                              className="text-[11px]"
                            >
                              {w.status}
                            </Badge>
                          </td>

                          <td className="px-4 py-3.5 whitespace-nowrap tabular text-gray-900 font-semibold">
                            {w.attempts} / 5
                          </td>

                          <td className="px-4 py-3.5 whitespace-nowrap text-gray-700 tabular">
                            {w.processedAt
                              ? `Processed ${formatDateTime(w.processedAt)}`
                              : w.nextAttemptAt
                              ? `Next: ${formatDateTime(w.nextAttemptAt)}`
                              : '—'}
                          </td>

                          <td className="px-4 py-3.5 font-mono text-[11px] text-gray-700 max-w-xs truncate">
                            {w.idempotencyKey}
                          </td>

                          <td className="px-4 py-3.5 text-gray-900 max-w-xs truncate">
                            {w.lastError ? (
                              <span className="text-red font-mono text-[11px]" title={w.lastError}>
                                {w.lastError}
                              </span>
                            ) : (
                              <span className="text-gray-700 italic">None</span>
                            )}
                          </td>

                          <td className="px-4 py-3.5 text-right whitespace-nowrap">
                            {isManager && (isDead || isFailed) ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                loading={replayingId === w.id}
                                onClick={() => void handleReplay(w)}
                                className="h-7 px-2 text-xs"
                              >
                                <RotateCw size={12} className="mr-1" /> Replay
                              </Button>
                            ) : null}
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
      )}

      {/* TAB 3: POS WEBHOOK SIMULATOR */}
      {activeTab === 'SIMULATOR' && (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          {/* Form */}
          <Card>
            <CardHeader>
              <div>
                <CardTitle>POS Event Test Harness</CardTitle>
                <p className="text-xs text-gray-700 mt-0.5">
                  Simulate external POS terminal webhooks with real cryptographic HMAC signatures and fault injection.
                </p>
              </div>
            </CardHeader>

            <CardBody>
              <form onSubmit={(e) => void handleSimulate(e)} className="space-y-4">
                <Field label="Event Type" htmlFor="sim-event">
                  <Select
                    id="sim-event"
                    value={simEventType}
                    onChange={(e) => setSimEventType(e.target.value as PosEventType)}
                  >
                    <option value="ticket.updated">ticket.updated (Items added/updated)</option>
                    <option value="order.item_voided">order.item_voided (Single dish voided)</option>
                    <option value="order.comp_applied">order.comp_applied (Manager courtesy discount)</option>
                    <option value="order.refunded">order.refunded (Post-settlement return)</option>
                  </Select>
                </Field>

                <Field label="Target Order ID (UUID)" htmlFor="sim-order" hint="Order must belong to this venue.">
                  <Input
                    id="sim-order"
                    value={simOrderId}
                    onChange={(e) => setSimOrderId(e.target.value)}
                    required
                    className="font-mono text-xs"
                  />
                </Field>

                {simEventType === 'ticket.updated' ? (
                  <div className="space-y-3 rounded-lg border border-border bg-background-2 p-3.5">
                    <span className="text-xs font-semibold text-gray-1000 block">Dish Payload</span>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Item Name" htmlFor="sim-dish">
                        <Input
                          id="sim-dish"
                          value={simItemName}
                          onChange={(e) => setSimItemName(e.target.value)}
                        />
                      </Field>
                      <Field label="Category" htmlFor="sim-cat">
                        <Select
                          id="sim-cat"
                          value={simItemCategory}
                          onChange={(e) => setSimItemCategory(e.target.value)}
                        >
                          {MENU_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Quantity" htmlFor="sim-qty">
                        <Input
                          id="sim-qty"
                          type="number"
                          min="1"
                          max="20"
                          value={simItemQty}
                          onChange={(e) => setSimItemQty(Number(e.target.value))}
                        />
                      </Field>
                      <Field label="Unit Price (₹ INR)" htmlFor="sim-price">
                        <Input
                          id="sim-price"
                          type="number"
                          min="10"
                          value={simItemPriceRupees}
                          onChange={(e) => setSimItemPriceRupees(e.target.value)}
                        />
                      </Field>
                    </div>
                  </div>
                ) : null}

                {['order.item_voided', 'order.refunded'].includes(simEventType) ? (
                  <div className="space-y-3 rounded-lg border border-border bg-background-2 p-3.5">
                    <Field label="Void Reason" htmlFor="sim-void-reason">
                      <Select
                        id="sim-void-reason"
                        value={simVoidReason}
                        onChange={(e) => setSimVoidReason(e.target.value)}
                      >
                        {VOID_REASONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field label="Authorized By" htmlFor="sim-auth">
                      <Input
                        id="sim-auth"
                        value={simAuthorizedBy}
                        onChange={(e) => setSimAuthorizedBy(e.target.value)}
                      />
                    </Field>
                  </div>
                ) : null}

                {simEventType === 'order.comp_applied' ? (
                  <div className="space-y-3 rounded-lg border border-border bg-background-2 p-3.5">
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Comp Amount (₹ INR)" htmlFor="sim-comp-amt">
                        <Input
                          id="sim-comp-amt"
                          type="number"
                          min="1"
                          value={simCompAmountRupees}
                          onChange={(e) => setSimCompAmountRupees(e.target.value)}
                        />
                      </Field>

                      <Field label="Authorized By" htmlFor="sim-auth-comp">
                        <Input
                          id="sim-auth-comp"
                          value={simAuthorizedBy}
                          onChange={(e) => setSimAuthorizedBy(e.target.value)}
                        />
                      </Field>
                    </div>
                  </div>
                ) : null}

                <div className="grid grid-cols-2 gap-4">
                  <Field label="Custom Idempotency Key" htmlFor="sim-idem" hint="Test deduplication">
                    <Input
                      id="sim-idem"
                      placeholder="Optional unique key"
                      value={simIdempotencyKey}
                      onChange={(e) => setSimIdempotencyKey(e.target.value)}
                      className="font-mono text-xs"
                    />
                  </Field>

                  <Field label="Force Failures (DLQ Retry Test)" htmlFor="sim-fail" hint="0 to 5 failures">
                    <Input
                      id="sim-fail"
                      type="number"
                      min="0"
                      max="10"
                      value={simFailTimes}
                      onChange={(e) => setSimFailTimes(Number(e.target.value))}
                    />
                  </Field>
                </div>

                <div className="flex justify-end pt-2">
                  <Button type="submit" variant="primary" size="sm" loading={simulating} className="gap-1.5">
                    <Play size={14} /> Send Simulated Webhook
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>

          {/* Response Console */}
          <Card>
            <CardHeader className="justify-between">
              <div className="flex items-center gap-2">
                <Terminal size={16} className="text-gray-800" />
                <CardTitle>Delivery Telemetry Response</CardTitle>
              </div>
              {simResult ? (
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(simResult, null, 2));
                    toast.info('Response JSON copied to clipboard');
                  }}
                  className="text-xs text-gray-700 hover:text-gray-1000 inline-flex items-center gap-1"
                >
                  <Copy size={12} /> Copy
                </button>
              ) : null}
            </CardHeader>

            <CardBody className="p-4">
              {simResult ? (
                <pre className="max-h-96 overflow-auto rounded-lg bg-gray-1000 p-4 font-mono text-xs text-emerald-400">
                  {JSON.stringify(simResult, null, 2)}
                </pre>
              ) : (
                <div className="flex flex-col items-center justify-center p-12 text-center text-xs text-gray-700">
                  <Radio size={32} className="mb-2 text-gray-400" />
                  <p className="font-medium text-gray-900">Awaiting simulation trigger</p>
                  <p className="mt-1 max-w-xs text-gray-700">
                    Configure your payload parameters and click &ldquo;Send Simulated Webhook&rdquo; to test processing pipeline.
                  </p>
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {/* TAB 4: AUDIT TRAIL */}
      {activeTab === 'AUDIT' && (
        <div className="space-y-4">
          {loadingAudit && auditLogs.length === 0 ? (
            <Card className="p-6">
              <Skeleton className="h-40 w-full" />
            </Card>
          ) : auditLogs.length === 0 ? (
            <EmptyState
              icon={<Shield size={36} className="text-gray-700" />}
              title="No audit entries"
              description="Administrative actions (pricing adjustments, table additions, preloads) are recorded in this immutable audit trail."
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border bg-background-2 text-gray-800 font-medium">
                      <th className="px-5 py-3">Timestamp</th>
                      <th className="px-4 py-3">Actor</th>
                      <th className="px-4 py-3">Action</th>
                      <th className="px-4 py-3">Entity</th>
                      <th className="px-4 py-3">Entity ID</th>
                      <th className="px-4 py-3 text-right">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {auditLogs.map((a) => (
                      <tr key={a.id} className="hover:bg-background-2/50 transition-colors">
                        <td className="px-5 py-3.5 whitespace-nowrap text-gray-700 tabular">
                          {formatDateTime(a.createdAt)}
                        </td>

                        <td className="px-4 py-3.5 whitespace-nowrap font-medium text-gray-1000">
                          {a.actor}
                        </td>

                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <Badge tone="neutral" className="font-mono text-[11px]">
                            {a.action}
                          </Badge>
                        </td>

                        <td className="px-4 py-3.5 whitespace-nowrap font-medium text-gray-900">
                          {a.entity}
                        </td>

                        <td className="px-4 py-3.5 font-mono text-[11px] text-gray-700">
                          {a.entityId || '—'}
                        </td>

                        <td className="px-4 py-3.5 text-right whitespace-nowrap">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setInspectAuditItem(a)}
                            className="h-7 px-2 text-xs"
                          >
                            <Eye size={12} className="mr-1" /> Inspect
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Inspect Audit Modal */}
      <Dialog
        open={Boolean(inspectAuditItem)}
        onClose={() => setInspectAuditItem(null)}
        title={inspectAuditItem ? `Audit Entry: ${inspectAuditItem.action}` : 'Audit Entry'}
        description={
          inspectAuditItem
            ? `Actor: ${inspectAuditItem.actor} · Entity: ${inspectAuditItem.entity} (${formatDateTime(
                inspectAuditItem.createdAt,
              )})`
            : undefined
        }
        footer={
          <Button variant="secondary" size="sm" onClick={() => setInspectAuditItem(null)}>
            Close
          </Button>
        }
      >
        <div className="space-y-4">
          <pre className="max-h-96 overflow-auto rounded-lg bg-gray-1000 p-4 font-mono text-xs text-white">
            {JSON.stringify(inspectAuditItem?.data ?? {}, null, 2)}
          </pre>
        </div>
      </Dialog>
    </div>
  );
}
