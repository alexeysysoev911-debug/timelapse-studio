// Модальное окно: фокус внутрь при открытии и обратно при закрытии, Tab не уходит за окно,
// закрытие щелчком по фону — только если и нажатие, и отпускание были на фоне
// (выделение текста мышью внутри окна его не закрывает).
import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ label, onClose, className, children }: { label: string; onClose: () => void; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const downOnBackdrop = useRef(false);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = box.current;
    const auto = el?.querySelector<HTMLElement>("[autofocus], [data-autofocus]");
    (auto ?? el)?.focus();
    return () => {
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === box.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      className="modal"
      onMouseDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) onClose();
      }}
    >
      <div ref={box} className={`dialog ${className ?? ""}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  );
}
