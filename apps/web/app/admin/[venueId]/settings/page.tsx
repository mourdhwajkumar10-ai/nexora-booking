'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Armchair,
  Ban,
  Building,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  Edit2,
  HelpCircle,
  Info,
  Lock,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Trash2,
  Users,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import type { DiningTableDto, DiningZone, ShiftDto, VenueSettings } from '@nexora/shared';
import { DINING_ZONES } from '@nexora/shared';
import { adminApi, apiMessage, send } from '@/components/admin/admin-api';
import { useConsole } from '@/components/admin/console-provider';
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
  Field,
  Input,
  Label,
  Select,
  Skeleton,
  Switch,
  Textarea,
} from '@/components/ui';

const DAYS_OF_WEEK = [
  { day: 1, label: 'Monday' },
  { day: 2, label: 'Tuesday' },
  { day: 3, label: 'Wednesday' },
  { day: 4, label: 'Thursday' },
  { day: 5, label: 'Friday' },
  { day: 6, label: 'Saturday' },
  { day: 0, label: 'Sunday' },
];

function parseHmToMins(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export default function VenueSettingsPage({
  params,
}: {
  params: Promise<{ venueId: string }>;
}) {
  const { venueId } = React.use(params);
  const { isManager, emit } = useConsole();

  const [loading, setLoading] = useState(true);
  const [venueSettings, setVenueSettings] = useState<VenueSettings | null>(null);

  // Operational Settings Form
  const [profileForm, setProfileForm] = useState({
    name: '',
    description: '',
    turnaroundMins: 30,
    gracePeriodMins: 15,
    triageTimeoutSecs: 300,
    allowUpsizeFallback: true,
  });
  const [savingProfile, setSavingProfile] = useState(false);

  // Blackout State
  const [blackoutEnabled, setBlackoutEnabled] = useState(false);
  const [blackoutReason, setBlackoutReason] = useState('');
  const [savingBlackout, setSavingBlackout] = useState(false);

  // Shifts State
  const [shifts, setShifts] = useState<ShiftDto[]>([]);
  const [savingShifts, setSavingShifts] = useState(false);
  const [shiftModalOpen, setShiftModalOpen] = useState(false);
  const [newShiftDay, setNewShiftDay] = useState<number>(1);
  const [newShiftOpen, setNewShiftOpen] = useState('12:00');
  const [newShiftClose, setNewShiftClose] = useState('16:00');

  // Tables State
  const [tables, setTables] = useState<DiningTableDto[]>([]);
  const [tableModalOpen, setTableModalOpen] = useState(false);
  const [editingTable, setEditingTable] = useState<DiningTableDto | null>(null);
  const [tableForm, setTableForm] = useState<{
    tableNumber: string;
    diningZone: DiningZone;
    minCapacity: number;
    maxCapacity: number;
  }>({
    tableNumber: '',
    diningZone: 'MAIN',
    minCapacity: 1,
    maxCapacity: 2,
  });
  const [savingTable, setSavingTable] = useState(false);

  // Delete Table Modal
  const [deleteTableItem, setDeleteTableItem] = useState<DiningTableDto | null>(null);
  const [deletingTable, setDeletingTable] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [settingsData, tablesData] = await Promise.all([
        adminApi<VenueSettings>(`/admin/venues/${venueId}`),
        adminApi<DiningTableDto[]>(`/admin/venues/${venueId}/tables`),
      ]);

      setVenueSettings(settingsData);
      setProfileForm({
        name: settingsData.name,
        description: settingsData.description || '',
        turnaroundMins: settingsData.turnaroundMins,
        gracePeriodMins: settingsData.gracePeriodMins,
        triageTimeoutSecs: settingsData.triageTimeoutSecs,
        allowUpsizeFallback: settingsData.allowUpsizeFallback,
      });
      setBlackoutEnabled(settingsData.blackout);
      setBlackoutReason(settingsData.blackoutReason || '');
      setShifts(settingsData.shifts || []);
      setTables(tablesData);
    } catch (e) {
      toast.error('Could not load venue settings', { description: apiMessage(e) });
    } finally {
      setLoading(false);
    }
  }, [venueId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Handle Profile Update
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isManager) {
      toast.error('Manager privileges required to edit venue settings');
      return;
    }

    setSavingProfile(true);
    try {
      const updated = await send<VenueSettings>('PATCH', `/admin/venues/${venueId}`, {
        name: profileForm.name.trim(),
        description: profileForm.description.trim(),
        turnaroundMins: Number(profileForm.turnaroundMins),
        gracePeriodMins: Number(profileForm.gracePeriodMins),
        triageTimeoutSecs: Number(profileForm.triageTimeoutSecs),
        allowUpsizeFallback: profileForm.allowUpsizeFallback,
      });
      setVenueSettings(updated);
      toast.success('Venue configuration updated');
      emit('venue:changed');
    } catch (err) {
      toast.error('Failed to update venue profile', { description: apiMessage(err) });
    } finally {
      setSavingProfile(false);
    }
  };

  // Handle Blackout Toggle
  const handleToggleBlackout = async (nextState: boolean) => {
    setSavingBlackout(true);
    try {
      const updated = await send<VenueSettings>('POST', `/admin/venues/${venueId}/blackout`, {
        enabled: nextState,
        reason: blackoutReason.trim() || undefined,
      });
      setBlackoutEnabled(updated.blackout);
      setVenueSettings(updated);
      toast.warning(nextState ? 'Emergency Blackout Activated' : 'Emergency Blackout Lifted', {
        description: nextState
          ? 'Online bookings are now paused across all consumer channels.'
          : 'Venue is now actively accepting online reservations.',
      });
      emit('venue:changed');
    } catch (err) {
      toast.error('Failed to change blackout status', { description: apiMessage(err) });
    } finally {
      setSavingBlackout(false);
    }
  };

  // Shifts Management
  const handleAddShift = (e: React.FormEvent) => {
    e.preventDefault();
    const openMins = parseHmToMins(newShiftOpen);
    const closeMins = parseHmToMins(newShiftClose);

    if (openMins === closeMins) {
      toast.error('Open and close time cannot be equal');
      return;
    }
    if (openMins % 15 !== 0 || closeMins % 15 !== 0) {
      toast.error('Times must be on 15-minute boundaries (e.g. 12:00, 12:15, 12:30)');
      return;
    }

    // Check overlap for the same day
    const dayShifts = shifts.filter((s) => s.dayOfWeek === newShiftDay);
    const hasOverlap = dayShifts.some((s) => {
      const sOpen = parseHmToMins(s.openTime);
      const sClose = parseHmToMins(s.closeTime);
      return Math.max(openMins, sOpen) < Math.min(closeMins, sClose);
    });

    if (hasOverlap) {
      toast.error('Shift overlaps with an existing shift on this day');
      return;
    }

    const updated = [...shifts, { dayOfWeek: newShiftDay, openTime: newShiftOpen, closeTime: newShiftClose }];
    setShifts(updated);
    setShiftModalOpen(false);
  };

  const handleRemoveShift = (index: number) => {
    setShifts((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSaveShifts = async () => {
    if (!isManager) {
      toast.error('Manager privileges required to edit operating shifts');
      return;
    }
    setSavingShifts(true);
    try {
      const updated = await send<VenueSettings>('PUT', `/admin/venues/${venueId}/shifts`, {
        shifts,
      });
      setVenueSettings(updated);
      toast.success('Weekly shift schedule updated successfully');
      emit('venue:changed');
    } catch (err) {
      toast.error('Failed to save shifts', { description: apiMessage(err) });
    } finally {
      setSavingShifts(false);
    }
  };

  // Tables Management
  const handleSaveTable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isManager) {
      toast.error('Manager privileges required to manage tables');
      return;
    }

    const min = Number(tableForm.minCapacity);
    const max = Number(tableForm.maxCapacity);
    if (max < min) {
      toast.error('Max capacity must be greater than or equal to min capacity');
      return;
    }

    setSavingTable(true);
    try {
      if (editingTable) {
        // Edit table
        const updated = await send<DiningTableDto>('PATCH', `/admin/tables/${editingTable.id}`, {
          tableNumber: tableForm.tableNumber.trim(),
          diningZone: tableForm.diningZone,
          minCapacity: min,
          maxCapacity: max,
        });
        setTables((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        toast.success(`Table ${updated.tableNumber} updated`);
      } else {
        // Create table
        const created = await send<DiningTableDto>('POST', `/admin/venues/${venueId}/tables`, {
          tableNumber: tableForm.tableNumber.trim(),
          diningZone: tableForm.diningZone,
          minCapacity: min,
          maxCapacity: max,
        });
        setTables((prev) => [...prev, created]);
        toast.success(`Table ${created.tableNumber} created`);
      }

      setTableModalOpen(false);
      setEditingTable(null);
      setTableForm({
        tableNumber: '',
        diningZone: 'MAIN',
        minCapacity: 1,
        maxCapacity: 2,
      });
      emit('floor:changed');
    } catch (err) {
      toast.error('Table operation failed', { description: apiMessage(err) });
    } finally {
      setSavingTable(false);
    }
  };

  const handleConfirmDeleteTable = async () => {
    if (!deleteTableItem || !isManager) return;
    setDeletingTable(true);
    try {
      await send('DELETE', `/admin/tables/${deleteTableItem.id}`);
      setTables((prev) => prev.filter((t) => t.id !== deleteTableItem.id));
      toast.success(`Table ${deleteTableItem.tableNumber} deleted`);
      setDeleteTableItem(null);
      emit('floor:changed');
    } catch (err) {
      toast.error('Could not delete table', { description: apiMessage(err) });
    } finally {
      setDeletingTable(false);
    }
  };

  // Group tables by dining zone
  const tablesByZone = useMemo(() => {
    const map: Record<string, DiningTableDto[]> = {};
    for (const z of DINING_ZONES) map[z] = [];
    for (const t of tables) {
      if (!map[t.diningZone]) map[t.diningZone] = [];
      map[t.diningZone].push(t);
    }
    // Sort tables by table number
    for (const z in map) {
      map[z].sort((a, b) =>
        a.tableNumber.localeCompare(b.tableNumber, undefined, { numeric: true, sensitivity: 'base' }),
      );
    }
    return map;
  }, [tables]);

  if (loading || !venueSettings) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 space-y-10">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-gray-1000">Venue Settings</h1>
            {!isManager ? (
              <Badge tone="slate" className="gap-1 text-xs">
                <Lock size={12} /> Read-Only (Host)
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-gray-800">
            Configure dining turnaround timing, emergency blackouts, weekly operating shifts, and table inventory.
          </p>
        </div>

        <Button variant="secondary" size="sm" onClick={() => void loadData()} className="gap-1.5">
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>

      {/* Emergency Blackout Card */}
      <Card
        className={`border-2 transition-colors ${
          blackoutEnabled
            ? 'border-red/50 bg-red-soft/30'
            : 'border-border bg-background'
        }`}
      >
        <CardBody className="p-6">
          <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-3.5">
              <div
                className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${
                  blackoutEnabled ? 'bg-red-soft text-red-fg' : 'bg-gray-100 text-gray-800'
                }`}
              >
                <Ban size={20} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-gray-1000">Emergency Booking Blackout</h3>
                  {blackoutEnabled ? (
                    <Badge tone="red" dot className="animate-pulse">
                      Active
                    </Badge>
                  ) : (
                    <Badge tone="neutral">Off</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-800 max-w-xl">
                  Immediately halts all public online reservation requests across consumer portals. Existing confirmed bookings and walk-ins remain valid.
                </p>

                {blackoutEnabled && blackoutReason ? (
                  <p className="mt-2 text-xs font-medium text-red-fg italic">
                    Reason: &ldquo;{blackoutReason}&rdquo;
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-3">
              <Input
                placeholder="Reason (e.g. Private buyout, weather event)"
                value={blackoutReason}
                onChange={(e) => setBlackoutReason(e.target.value)}
                disabled={!isManager || savingBlackout}
                className="h-9 w-full sm:w-64 text-xs"
              />
              <div className="flex items-center gap-2">
                <Switch
                  checked={blackoutEnabled}
                  onChange={(checked) => void handleToggleBlackout(checked)}
                  disabled={!isManager || savingBlackout}
                  label="Emergency Blackout"
                />
                <span className="text-xs font-semibold text-gray-900">
                  {blackoutEnabled ? 'Blackout Active' : 'Normal Operations'}
                </span>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Operational Settings Form */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Operational Pacing & Turnaround Parameters</CardTitle>
            <p className="text-xs text-gray-700 mt-0.5">
              Defines table hold durations, host arrival grace windows, and triage decision timeouts.
            </p>
          </div>
        </CardHeader>

        <CardBody>
          <form onSubmit={(e) => void handleSaveProfile(e)} className="space-y-6">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <Field label="Venue Display Name" htmlFor="venue-name">
                <Input
                  id="venue-name"
                  value={profileForm.name}
                  disabled={!isManager}
                  onChange={(e) => setProfileForm((p) => ({ ...p, name: e.target.value }))}
                  required
                />
              </Field>

              <Field label="Turnaround Duration (Minutes)" htmlFor="venue-turnaround" hint="Multiples of 15 minutes. Controls reservation pacing slot length.">
                <Select
                  id="venue-turnaround"
                  value={profileForm.turnaroundMins}
                  disabled={!isManager}
                  onChange={(e) =>
                    setProfileForm((p) => ({ ...p, turnaroundMins: Number(e.target.value) }))
                  }
                >
                  <option value={15}>15 Minutes</option>
                  <option value={30}>30 Minutes</option>
                  <option value={45}>45 Minutes</option>
                  <option value={60}>60 Minutes (1 Hour)</option>
                  <option value={75}>75 Minutes</option>
                  <option value={90}>90 Minutes (1.5 Hours)</option>
                  <option value={120}>120 Minutes (2 Hours)</option>
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
              <Field label="Grace Period (Minutes)" htmlFor="venue-grace" hint="Window before auto-flagging no-show.">
                <Select
                  id="venue-grace"
                  value={profileForm.gracePeriodMins}
                  disabled={!isManager}
                  onChange={(e) =>
                    setProfileForm((p) => ({ ...p, gracePeriodMins: Number(e.target.value) }))
                  }
                >
                  <option value={5}>5 Minutes</option>
                  <option value={10}>10 Minutes</option>
                  <option value={15}>15 Minutes (Default)</option>
                  <option value={20}>20 Minutes</option>
                  <option value={30}>30 Minutes</option>
                </Select>
              </Field>

              <Field label="Triage Timeout (Seconds)" htmlFor="venue-timeout" hint="Time limit before request escalates.">
                <Select
                  id="venue-timeout"
                  value={profileForm.triageTimeoutSecs}
                  disabled={!isManager}
                  onChange={(e) =>
                    setProfileForm((p) => ({ ...p, triageTimeoutSecs: Number(e.target.value) }))
                  }
                >
                  <option value={120}>120 Seconds (2 Mins)</option>
                  <option value={300}>300 Seconds (5 Mins)</option>
                  <option value={600}>600 Seconds (10 Mins)</option>
                  <option value={1800}>1800 Seconds (30 Mins)</option>
                </Select>
              </Field>

              <div className="flex flex-col justify-center pt-2">
                <div className="flex items-center gap-3">
                  <Switch
                    id="venue-upsize"
                    checked={profileForm.allowUpsizeFallback}
                    disabled={!isManager}
                    onChange={(v) => setProfileForm((p) => ({ ...p, allowUpsizeFallback: v }))}
                  />
                  <Label htmlFor="venue-upsize" className="mb-0 cursor-pointer">
                    Allow Upsize Fallback
                  </Label>
                </div>
                <p className="mt-1 text-xs text-gray-700">
                  Allows allocating a 4-top table to a party of 2 if all 2-tops are booked.
                </p>
              </div>
            </div>

            <Field label="Description & Notes" htmlFor="venue-desc">
              <Textarea
                id="venue-desc"
                rows={3}
                value={profileForm.description}
                disabled={!isManager}
                onChange={(e) => setProfileForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="Brief public venue description..."
              />
            </Field>

            {isManager ? (
              <div className="flex justify-end pt-2">
                <Button type="submit" variant="primary" size="sm" loading={savingProfile} className="gap-1.5">
                  <Save size={14} /> Save Pacing Settings
                </Button>
              </div>
            ) : null}
          </form>
        </CardBody>
      </Card>

      {/* Weekly Operating Shifts Schedule Editor */}
      <Card>
        <CardHeader className="justify-between">
          <div>
            <CardTitle>Weekly Operating Shifts Schedule</CardTitle>
            <p className="text-xs text-gray-700 mt-0.5">
              Configured shift intervals dictate online availability booking slots. Overlapping shifts within a day are strictly rejected.
            </p>
          </div>
          {isManager ? (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShiftModalOpen(true)}
                className="gap-1.5"
              >
                <Plus size={14} /> Add Shift
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={savingShifts}
                onClick={() => void handleSaveShifts()}
                className="gap-1.5"
              >
                <Check size={14} /> Save Shifts
              </Button>
            </div>
          ) : null}
        </CardHeader>

        <CardBody className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-7 gap-4">
            {DAYS_OF_WEEK.map(({ day, label }) => {
              const dayShifts = shifts
                .map((s, idx) => ({ ...s, originalIndex: idx }))
                .filter((s) => s.dayOfWeek === day);

              return (
                <div key={day} className="rounded-lg border border-border bg-background-2 p-3 text-xs flex flex-col justify-between min-h-[160px]">
                  <div>
                    <span className="font-semibold text-gray-1000 block border-b border-border pb-1.5">
                      {label}
                    </span>

                    <div className="mt-2.5 space-y-1.5">
                      {dayShifts.length > 0 ? (
                        dayShifts.map((s) => (
                          <div
                            key={s.originalIndex}
                            className="flex items-center justify-between rounded-md border border-border bg-background px-2 py-1 shadow-2xs group"
                          >
                            <span className="font-medium text-gray-900 tabular">
                              {s.openTime} - {s.closeTime}
                            </span>
                            {isManager ? (
                              <button
                                type="button"
                                onClick={() => handleRemoveShift(s.originalIndex)}
                                className="text-gray-700 hover:text-red transition-colors"
                                title="Remove shift"
                              >
                                <X size={12} />
                              </button>
                            ) : null}
                          </div>
                        ))
                      ) : (
                        <span className="text-[11px] text-gray-700 italic block pt-2">Closed</span>
                      )}
                    </div>
                  </div>

                  {isManager ? (
                    <button
                      type="button"
                      onClick={() => {
                        setNewShiftDay(day);
                        setShiftModalOpen(true);
                      }}
                      className="mt-3 text-[11px] font-medium text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      <Plus size={11} /> Add
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>

      {/* Dining Tables Management */}
      <Card>
        <CardHeader className="justify-between">
          <div>
            <CardTitle>Dining Tables & Capacity Inventory</CardTitle>
            <p className="text-xs text-gray-700 mt-0.5">
              Organized by dining zone. Active tables accept seating allocations and floor assignments.
            </p>
          </div>
          {isManager ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setEditingTable(null);
                setTableForm({ tableNumber: '', diningZone: 'MAIN', minCapacity: 1, maxCapacity: 2 });
                setTableModalOpen(true);
              }}
              className="gap-1.5"
            >
              <Plus size={14} /> Add Dining Table
            </Button>
          ) : null}
        </CardHeader>

        <CardBody className="space-y-6">
          {Object.entries(tablesByZone).map(([zone, zoneTables]) => (
            <div key={zone} className="space-y-2">
              <div className="flex items-center justify-between border-b border-border pb-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-gray-800">
                  {zone} ZONE ({zoneTables.length} {zoneTables.length === 1 ? 'Table' : 'Tables'})
                </span>
              </div>

              {zoneTables.length === 0 ? (
                <p className="text-xs text-gray-700 italic py-2">No tables assigned to {zone} zone.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                  {zoneTables.map((t) => (
                    <div
                      key={t.id}
                      className="flex flex-col justify-between rounded-lg border border-border bg-background-2 p-3 shadow-2xs hover:border-border-strong transition-all"
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-gray-1000 text-sm">Table {t.tableNumber}</span>
                          <Badge
                            tone={
                              t.status === 'AVAILABLE'
                                ? 'green'
                                : t.status === 'OCCUPIED'
                                ? 'blue'
                                : 'slate'
                            }
                            className="text-[10px] h-4 px-1.5"
                          >
                            {t.status}
                          </Badge>
                        </div>
                        <span className="text-xs text-gray-700 mt-1 block">
                          Capacity: {t.minCapacity} - {t.maxCapacity} covers
                        </span>
                        {t.upcomingReservations > 0 ? (
                          <span className="text-[11px] text-amber-fg font-medium mt-1 block tabular">
                            {t.upcomingReservations} upcoming {t.upcomingReservations === 1 ? 'booking' : 'bookings'}
                          </span>
                        ) : null}
                      </div>

                      {isManager ? (
                        <div className="mt-3 flex items-center justify-end gap-1.5 border-t border-border pt-2">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingTable(t);
                              setTableForm({
                                tableNumber: t.tableNumber,
                                diningZone: t.diningZone as DiningZone,
                                minCapacity: t.minCapacity,
                                maxCapacity: t.maxCapacity,
                              });
                              setTableModalOpen(true);
                            }}
                            className="p-1 text-gray-700 hover:text-gray-1000 transition-colors"
                            title="Edit Table"
                          >
                            <Edit2 size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTableItem(t)}
                            className="p-1 text-gray-700 hover:text-red transition-colors"
                            title="Delete Table"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </CardBody>
      </Card>

      {/* Add / Edit Table Modal */}
      <Dialog
        open={tableModalOpen}
        onClose={() => setTableModalOpen(false)}
        title={editingTable ? `Edit Table ${editingTable.tableNumber}` : 'Add New Dining Table'}
        description="Specify alphanumeric table number, seating zone, and party size capacity range."
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTableModalOpen(false)}
              disabled={savingTable}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={savingTable}
              onClick={(e) => void handleSaveTable(e)}
            >
              {editingTable ? 'Save Changes' : 'Create Table'}
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => void handleSaveTable(e)} className="space-y-4">
          <Field label="Table Number / Identifier" htmlFor="tbl-num">
            <Input
              id="tbl-num"
              placeholder="e.g. T-12, B-1, 14"
              required
              value={tableForm.tableNumber}
              onChange={(e) => setTableForm((p) => ({ ...p, tableNumber: e.target.value }))}
            />
          </Field>

          <Field label="Dining Zone" htmlFor="tbl-zone">
            <Select
              id="tbl-zone"
              value={tableForm.diningZone}
              onChange={(e) => setTableForm((p) => ({ ...p, diningZone: e.target.value as DiningZone }))}
            >
              {DINING_ZONES.map((z) => (
                <option key={z} value={z}>
                  {z} Zone
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Min Capacity" htmlFor="tbl-min">
              <Input
                id="tbl-min"
                type="number"
                min="1"
                max="20"
                required
                value={tableForm.minCapacity}
                onChange={(e) => setTableForm((p) => ({ ...p, minCapacity: Number(e.target.value) }))}
              />
            </Field>

            <Field label="Max Capacity" htmlFor="tbl-max">
              <Input
                id="tbl-max"
                type="number"
                min="1"
                max="20"
                required
                value={tableForm.maxCapacity}
                onChange={(e) => setTableForm((p) => ({ ...p, maxCapacity: Number(e.target.value) }))}
              />
            </Field>
          </div>
        </form>
      </Dialog>

      {/* Delete Table Confirmation Modal */}
      <Dialog
        open={Boolean(deleteTableItem)}
        onClose={() => setDeleteTableItem(null)}
        title="Delete Dining Table"
        description={
          deleteTableItem
            ? `Are you sure you want to remove Table ${deleteTableItem.tableNumber} from active inventory?`
            : undefined
        }
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDeleteTableItem(null)}
              disabled={deletingTable}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={deletingTable}
              onClick={() => void handleConfirmDeleteTable()}
            >
              Confirm Delete
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {deleteTableItem && deleteTableItem.upcomingReservations > 0 ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-red/30 bg-red-soft p-3 text-xs text-red-fg">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <div>
                <span className="font-bold block">Caution: Active Upcoming Bookings</span>
                <span className="block mt-0.5">
                  Table {deleteTableItem.tableNumber} currently has{' '}
                  <strong>{deleteTableItem.upcomingReservations}</strong> active upcoming reservation(s).
                  Deleting this table will remove it from future inventory and require reassigning existing bookings.
                </span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-800">
              The table will be archived immediately. Past completed reservation records remain intact in audit logs.
            </p>
          )}
        </div>
      </Dialog>

      {/* Add Shift Modal */}
      <Dialog
        open={shiftModalOpen}
        onClose={() => setShiftModalOpen(false)}
        title="Add Operating Shift"
        description="Specify the day and 15-minute aligned operating window."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setShiftModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={(e) => void handleAddShift(e)}>
              Add to Schedule
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => void handleAddShift(e)} className="space-y-4">
          <Field label="Day of Week" htmlFor="shift-day">
            <Select
              id="shift-day"
              value={newShiftDay}
              onChange={(e) => setNewShiftDay(Number(e.target.value))}
            >
              {DAYS_OF_WEEK.map(({ day, label }) => (
                <option key={day} value={day}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Open Time (HH:mm)" htmlFor="shift-open">
              <Input
                id="shift-open"
                type="time"
                step="900"
                required
                value={newShiftOpen}
                onChange={(e) => setNewShiftOpen(e.target.value)}
              />
            </Field>

            <Field label="Close Time (HH:mm)" htmlFor="shift-close">
              <Input
                id="shift-close"
                type="time"
                step="900"
                required
                value={newShiftClose}
                onChange={(e) => setNewShiftClose(e.target.value)}
              />
            </Field>
          </div>
          <p className="text-xs text-gray-700">
            Note: Click &ldquo;Save Shifts&rdquo; on the main page to commit all weekly schedule changes to the server.
          </p>
        </form>
      </Dialog>
    </div>
  );
}
