import { cn } from '@/lib/cn';

export type BadgeTone = 'neutral' | 'green' | 'amber' | 'blue' | 'yellow' | 'slate' | 'red' | 'accent';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-gray-100 text-gray-1000 border-border',
  green: 'bg-success-soft text-success-fg border-success/20',
  amber: 'bg-amber-soft text-amber-fg border-amber/25',
  blue: 'bg-blue-soft text-blue-fg border-blue/20',
  yellow: 'bg-yellow-soft text-yellow-fg border-yellow/25',
  slate: 'bg-slate-soft text-slate-fg border-slate/20',
  red: 'bg-red-soft text-red-fg border-red/20',
  accent: 'bg-accent-soft text-accent border-accent/20',
};

export function Badge({ tone = 'neutral', className, children, dot, title }: { tone?: BadgeTone; className?: string; children: React.ReactNode; dot?: boolean; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium', tones[tone], className)}>
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/** Canonical tone for each floor/reservation/order status. */
export const STATUS_TONE: Record<string, BadgeTone> = {
  AVAILABLE: 'green',
  RESERVED: 'amber',
  OCCUPIED: 'blue',
  BUSSING: 'yellow',
  BLOCKED: 'slate',
  REQUESTED: 'amber',
  CONFIRMED: 'green',
  ARRIVED: 'blue',
  LATE: 'amber',
  SEATED: 'blue',
  COMPLETED: 'neutral',
  CANCELLED: 'slate',
  NO_SHOW: 'red',
  PLACED: 'neutral',
  RECEIVED: 'accent',
  PREPARING: 'amber',
  SERVED: 'blue',
  BILLED: 'green',
  VOIDED: 'red',
  PARTIALLY_PAID: 'amber',
};

export const statusLabel = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'} dot className={className}>
      {statusLabel(status)}
    </Badge>
  );
}
