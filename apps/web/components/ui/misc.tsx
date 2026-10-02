import { cn } from '@/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-gray-100', className)} />;
}

export function EmptyState({ icon, title, description, action, className }: { icon?: React.ReactNode; title: string; description?: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-12 text-center', className)}>
      {icon ? <div className="mb-3 text-gray-700">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-gray-900">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border bg-background-2 px-1.5 font-mono text-[11px] text-gray-900">{children}</kbd>;
}

export function Separator({ className }: { className?: string }) {
  return <hr className={cn('border-border', className)} />;
}

/** Segmented control (Vercel-style tabs). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  itemClassName,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode }[];
  className?: string;
  itemClassName?: string;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('inline-flex rounded-lg border border-border bg-background-2 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-8 rounded-md px-3 text-[13px] font-medium text-gray-900 transition-colors',
            value === o.value ? 'bg-background text-gray-1000 shadow-sm ring-1 ring-border' : 'hover:text-gray-1000',
            itemClassName,
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
