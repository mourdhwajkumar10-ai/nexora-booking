'use client';

import { useState, useEffect, useTransition } from 'react';
import type { FloorTable, WalkInCheckResponse } from '@nexora/shared';
import { send, apiMessage } from '../admin-api';
import { useConsole } from '../console-provider';
import { Button, Dialog, Field, Input, Select } from '@/components/ui';
import { toast } from 'sonner';
import { AlertCircle, Check, Sparkles, Users } from 'lucide-react';
import { cn } from '@/lib/cn';

interface WalkInDialogProps {
  open: boolean;
  onClose: () => void;
  tables: FloorTable[];
  preselectedTable?: FloorTable | null;
  onSuccess?: () => void;
}

export function WalkInDialog({
  open,
  onClose,
  tables,
  preselectedTable,
  onSuccess,
}: WalkInDialogProps) {
  const { venueId, emit } = useConsole();

  const [partySize, setPartySize] = useState<number>(2);
  const [selectedTableId, setSelectedTableId] = useState<string>('');
  const [guestName, setGuestName] = useState<string>('');
  const [phone, setPhone] = useState<string>('');
  const [override, setOverride] = useState<boolean>(false);

  const [checking, setChecking] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [checkResult, setCheckResult] = useState<WalkInCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Initialize selected table when opened
  useEffect(() => {
    if (open) {
      setError(null);
      setOverride(false);
      if (preselectedTable) {
        setSelectedTableId(preselectedTable.id);
        setPartySize(Math.max(1, Math.min(preselectedTable.maxCapacity, 2)));
      } else {
        setSelectedTableId('');
        setPartySize(2);
      }
      setGuestName('');
      setPhone('');
    }
  }, [open, preselectedTable]);

  // Run collision check whenever partySize or selectedTableId changes
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    async function runCheck() {
      setChecking(true);
      setError(null);
      try {
        const payload: { partySize: number; tableId?: string } = { partySize };
        if (selectedTableId) {
          payload.tableId = selectedTableId;
        }
        const res = await send<WalkInCheckResponse>('POST', `/admin/venues/${venueId}/walk-ins/check`, payload);
        if (!cancelled) {
          setCheckResult(res);
          // If auto-assigned table returned and host hasn't manually picked one
          if (!selectedTableId && res.tableId) {
            setSelectedTableId(res.tableId);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(apiMessage(e));
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    const timer = setTimeout(runCheck, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, venueId, partySize, selectedTableId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const targetTableId = selectedTableId || checkResult?.tableId;
    if (!targetTableId) {
      setError('No compatible table selected. Please pick an available table.');
      return;
    }

    if (checkResult && !checkResult.ok && !override) {
      setError('Please resolve table collision or check "Override Collision" to proceed.');
      return;
    }

    setSubmitting(true);
    try {
      await send('POST', `/admin/venues/${venueId}/walk-ins`, {
        partySize,
        tableId: targetTableId,
        guestName: guestName.trim() || undefined,
        phone: phone.trim() || undefined,
        override,
      });

      toast.success('Walk-in guest seated successfully');
      emit('floor:changed');
      emit('reservation:changed');
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const hasCollision = checkResult && !checkResult.ok;
  const currentTable = tables.find((t) => t.id === selectedTableId);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Seat Walk-in Party"
      description="Seat an unbooked party with immediate live collision verification."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red/20 bg-red-soft p-3 text-xs text-red-fg"
          >
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <div className="leading-relaxed">{error}</div>
          </div>
        ) : null}

        {/* Party size and Table selection */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Party Size" htmlFor="walkin-partysize">
            <Select
              id="walkin-partysize"
              value={partySize}
              onChange={(e) => setPartySize(Number(e.target.value))}
              disabled={submitting}
            >
              {[1, 2, 3, 4, 5, 6, 8].map((size) => (
                <option key={size} value={size}>
                  {size} {size === 1 ? 'Guest' : 'Guests'}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Table Assignment" htmlFor="walkin-table">
            <Select
              id="walkin-table"
              value={selectedTableId}
              onChange={(e) => {
                setSelectedTableId(e.target.value);
                setOverride(false);
              }}
              disabled={submitting}
            >
              <option value="">Auto-assign Best Table</option>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.tableNumber} ({t.diningZone}, {t.maxCapacity} seats) - {t.floorStatus}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {/* Live Collision Alert Banner */}
        {hasCollision ? (
          <div
            role="alert"
            className="rounded-lg border border-amber/30 bg-amber-soft p-3.5 text-xs text-amber-fg space-y-2 animate-fade-in"
          >
            <div className="flex items-start gap-2 font-semibold">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber" />
              <span>{checkResult.message || 'Collision detected with upcoming reservation.'}</span>
            </div>

            {/* Suggestions */}
            {checkResult.suggestions && checkResult.suggestions.length > 0 ? (
              <div className="pt-1">
                <span className="block text-[11px] font-medium text-amber-fg/90 mb-1.5">
                  Conflict-free alternative tables:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {checkResult.suggestions.map((sug) => (
                    <button
                      key={sug.tableId}
                      type="button"
                      onClick={() => {
                        setSelectedTableId(sug.tableId);
                        setOverride(false);
                      }}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border border-amber/30 bg-background px-2.5 py-1 text-xs font-medium text-gray-1000 shadow-sm transition-colors hover:bg-amber-soft hover:border-amber',
                        selectedTableId === sug.tableId && 'ring-2 ring-amber',
                      )}
                    >
                      <Sparkles size={11} className="text-amber" />
                      <span>{sug.tableNumber} ({sug.maxCapacity}s)</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Override Checkbox */}
            <div className="pt-2 border-t border-amber/20">
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer text-gray-1000 select-none">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                  className="rounded border-gray-300 text-gray-1000 focus:ring-gray-1000"
                />
                <span>Override collision and force seat at table</span>
              </label>
            </div>
          </div>
        ) : checkResult && checkResult.ok ? (
          <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success-soft px-3 py-2 text-xs text-success-fg">
            <Check size={14} className="shrink-0" />
            <span>
              {currentTable
                ? `Table ${currentTable.tableNumber} is clear for ${partySize} guests without overlaps.`
                : 'Compatible table available without upcoming conflicts.'}
            </span>
          </div>
        ) : null}

        {/* Optional Guest Details */}
        <div className="grid grid-cols-2 gap-3 pt-1">
          <Field label="Guest Name (Optional)" htmlFor="walkin-name">
            <Input
              id="walkin-name"
              placeholder="e.g. Rahul Verma"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              disabled={submitting}
            />
          </Field>

          <Field label="Phone (Optional)" htmlFor="walkin-phone">
            <Input
              id="walkin-phone"
              type="tel"
              placeholder="+91 98100 00000"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={submitting}
            />
          </Field>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-3 border-t border-border">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={hasCollision && override ? 'danger' : 'primary'}
            loading={submitting || checking}
            disabled={Boolean(hasCollision && !override)}
          >
            {hasCollision && override ? 'Override & Seat' : 'Seat Walk-in'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
