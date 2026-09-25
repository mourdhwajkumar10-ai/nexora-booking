import { cn } from '@/lib/cn';

/** Label + control + hint/error, wiring aria-describedby so screen readers read the error. */
export function FormField({
  id,
  label,
  optional,
  error,
  hint,
  className,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
  hint?: string;
  className?: string;
  children: (a11y: { id: string; 'aria-invalid': boolean | undefined; 'aria-describedby': string | undefined }) => React.ReactNode;
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 flex items-baseline justify-between text-[13px] font-medium text-gray-1000">
        {label}
        {optional ? <span className="text-xs font-normal text-gray-800">Optional</span> : null}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[13px] text-red-fg">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-[13px] text-gray-800">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Mobile-safe control sizing: 16px text on phones avoids iOS zoom-on-focus. */
export const controlText = 'text-base sm:text-sm';

export function Notice({ tone = 'neutral', title, children, className, live }: { tone?: 'neutral' | 'red' | 'amber' | 'green'; title?: string; children?: React.ReactNode; className?: string; live?: boolean }) {
  const tones = {
    neutral: 'border-border bg-background-2 text-gray-1000',
    red: 'border-red/20 bg-red-soft text-red-fg',
    amber: 'border-amber/25 bg-amber-soft text-amber-fg',
    green: 'border-success/20 bg-success-soft text-success-fg',
  } as const;
  return (
    <div role={live ? 'alert' : undefined} className={cn('rounded-lg border px-3.5 py-3 text-[13px] leading-relaxed', tones[tone], className)}>
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? <div className={cn(title && 'mt-0.5 opacity-90')}>{children}</div> : null}
    </div>
  );
}
