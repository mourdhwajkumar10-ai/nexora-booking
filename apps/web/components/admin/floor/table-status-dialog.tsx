'use client';

import { useState, useEffect } from 'react';
import type { FloorTable, TableStatus } from '@nexora/shared';
import { send, apiMessage } from '../admin-api';
import { useConsole } from '../console-provider';
import { Button, Dialog, Field, Input } from '@/components/ui';
import { toast } from 'sonner';
import { AlertCircle, AlertTriangle, CheckCircle2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';

interface TableStatusDialogProps {
  open: boolean;
  onClose: () => void;
  table: FloorTable | null;
  onSuccess?: () => void;
}

type ManagedStatus = 'AVAILABLE' | 'BUSSING' | 'BLOCKED';

export function TableStatusDialog({
  open,
  onClose,
  table,
  onSuccess,
}: TableStatusDialogProps) {
  const { emit } = useConsole();
  const [status, setStatus] = useState<ManagedStatus>('AVAILABLE');
  const [reason, setReason] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && table) {
      setError(null);
      setReason('');
      if (table.physicalStatus === 'BLOCKED') setStatus('BLOCKED');
      else if (table.physicalStatus === 'BUSSING') setStatus('BUSSING');
      else setStatus('AVAILABLE');
    }
  }, [open, table]);

  if (!table) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!table) return;
    setError(null);
    setSubmitting(true);

    try {
      await send('POST', `/admin/tables/${table.id}/status`, {
        status,
        reason: reason.trim() || undefined,
      });

      toast.success(`Table ${table.tableNumber} status updated to ${status}`);
      emit('floor:changed');
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const options: { value: ManagedStatus; label: string; desc: string; icon: typeof CheckCircle2 }[] = [
    {
      value: 'AVAILABLE',
      label: 'Available',
      desc: 'Table is cleaned, reset, and ready for immediate seating',
      icon: CheckCircle2,
    },
    {
      value: 'BUSSING',
      label: 'Bussing',
      desc: 'Table requires clearing, sanitizing, or table setting',
      icon: Sparkles,
    },
    {
      value: 'BLOCKED',
      label: 'Blocked',
      desc: 'Out of service for maintenance, reservation hold, or defect',
      icon: AlertTriangle,
    },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Table ${table.tableNumber} Status`}
      description={`Update physical operational state for Table ${table.tableNumber} (${table.diningZone} zone, ${table.maxCapacity} seats).`}
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

        <div className="space-y-2">
          <label className="text-[13px] font-medium text-gray-900">Select Operational State</label>
          <div className="grid gap-2">
            {options.map((opt) => {
              const Icon = opt.icon;
              const isSelected = status === opt.value;
              return (
                <div
                  key={opt.value}
                  onClick={() => setStatus(opt.value)}
                  className={cn(
                    'flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors',
                    isSelected
                      ? 'border-gray-1000 bg-background-2 ring-1 ring-gray-1000'
                      : 'border-border bg-background hover:border-gray-400',
                  )}
                >
                  <Icon
                    size={18}
                    className={cn(
                      'mt-0.5 shrink-0',
                      opt.value === 'AVAILABLE'
                        ? 'text-success-fg'
                        : opt.value === 'BUSSING'
                          ? 'text-yellow-fg'
                          : 'text-slate-fg',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-gray-1000">{opt.label}</div>
                    <div className="text-[11px] text-gray-800 leading-snug">{opt.desc}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <Field
          label="Reason or Notes (Optional)"
          htmlFor="status-reason"
          hint="Audit trail reason recorded for floor reporting"
        >
          <Input
            id="status-reason"
            placeholder={
              status === 'BLOCKED'
                ? 'e.g. Wobbly leg, private event hold'
                : status === 'BUSSING'
                  ? 'e.g. Large party clearing, deep sanitization'
                  : 'e.g. Table inspected and reset'
            }
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
          />
        </Field>

        <div className="flex justify-end gap-2 pt-3 border-t border-border">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            Update Status
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
