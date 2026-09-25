'use client';
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Right-hand side drawer built on the native <dialog> element (focus trap + Esc from the browser).
 * Close/cancel events are only honoured when they originate from this dialog, so nested dialogs
 * rendered inside the sheet don't close it when they close.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  headerExtra,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  headerExtra?: React.ReactNode;
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
      aria-labelledby="sheet-title"
      onClose={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onCancel={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        'fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-[460px] border-l border-border bg-background p-0 text-gray-1000 shadow-lg',
        'backdrop:bg-black/20',
        'translate-x-0 opacity-100 transition-[translate,opacity] duration-150 ease-out starting:open:translate-x-6 starting:open:opacity-0',
        className,
      )}
    >
      {open ? (
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <h2 id="sheet-title" className="text-base font-semibold tracking-tight">
                {title}
              </h2>
              {description ? <div className="mt-1 text-sm text-gray-900">{description}</div> : null}
            </div>
            <div className="flex items-center gap-2">
              {headerExtra}
              <button type="button" onClick={onClose} aria-label="Close panel" className="-mr-1 rounded-md p-1.5 text-gray-900 transition-colors duration-150 hover:bg-gray-100">
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-background-2 px-5 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
