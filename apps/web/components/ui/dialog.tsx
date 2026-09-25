'use client';
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Accessible modal built on the native <dialog> element (focus trap + Esc handled by the browser). */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="dialog-title"
      className={cn(
        'm-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border border-border bg-background p-0 text-gray-1000 shadow-lg backdrop:bg-black/30 backdrop:backdrop-blur-[2px]',
        'open:animate-fade-in',
        className,
      )}
    >
      {open ? (
        <div>
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div>
              <h2 id="dialog-title" className="text-base font-semibold tracking-tight">
                {title}
              </h2>
              {description ? <p className="mt-1 text-sm text-gray-900">{description}</p> : null}
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 rounded-md p-1 text-gray-900 hover:bg-gray-100">
              <X size={16} />
            </button>
          </div>
          {children ? <div className="px-5 py-4">{children}</div> : <div className="h-4" />}
          {footer ? <div className="flex justify-end gap-2 rounded-b-xl border-t border-border bg-background-2 px-5 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
