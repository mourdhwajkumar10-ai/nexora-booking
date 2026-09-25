import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

const field =
  'w-full rounded-md border border-border bg-background px-3 text-sm text-gray-1000 placeholder:text-gray-700 transition-colors ' +
  'hover:border-border-strong focus:border-gray-1000 focus:outline-none focus:ring-2 focus:ring-gray-1000/10 ' +
  'disabled:cursor-not-allowed disabled:bg-background-2 disabled:text-gray-800 aria-[invalid=true]:border-red aria-[invalid=true]:ring-red/15';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(field, 'h-10', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(field, 'min-h-20 py-2 leading-relaxed', className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return (
    <div className="relative">
      <select ref={ref} className={cn(field, 'h-10 appearance-none pr-9', className)} {...props}>
        {children}
      </select>
      <svg aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-900" width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
});

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1.5 block text-[13px] font-medium text-gray-900', className)} {...props} />;
}

export function Field({ label, htmlFor, error, hint, children, className }: { label: string; htmlFor: string; error?: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p role="alert" className="mt-1.5 text-[13px] text-red-fg">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-[13px] text-gray-800">{hint}</p>
      ) : null}
    </div>
  );
}
