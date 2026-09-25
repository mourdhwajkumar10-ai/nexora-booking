'use client';
import { cn } from '@/lib/cn';

/** Accessible toggle switch (role="switch"). */
export function Switch({
  checked,
  onChange,
  id,
  disabled,
  label,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  id?: string;
  disabled?: boolean;
  /** Accessible name when no visible <label htmlFor> exists. */
  label?: string;
  className?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-gray-1000 bg-gray-1000' : 'border-border-strong bg-gray-200',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-block size-3.5 rounded-full bg-white shadow-sm transition-[translate] duration-150',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}
