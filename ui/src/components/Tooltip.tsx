// Подсказки во всей программе: любой элемент с атрибутом data-tip.
// Появляются через 300 мс (как во Fluent/Windows 11), при переходе между кнопками — сразу,
// работают с клавиатуры (Tab), подстраиваются под край окна.
import { useEffect, useRef, useState } from "react";

const DELAY = 300;
const WARM_MS = 600;

interface Tip {
  text: string;
  x: number;
  y: number;
  below: boolean;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHide = useRef(0);
  const current = useRef<HTMLElement | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const show = (el: HTMLElement) => {
      const text = el.getAttribute("data-tip");
      if (!text) return;
      const r = el.getBoundingClientRect();
      const below = r.top < 70;
      setShift(0);
      setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
    };
    const hide = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (current.current) lastHide.current = Date.now();
      current.current = null;
      setTip(null);
    };
    const enter = (target: EventTarget | null) => {
      const el = (target as HTMLElement | null)?.closest?.("[data-tip]") as HTMLElement | null;
      if (el === current.current) return;
      if (!el) return hide();
      if (timer.current) clearTimeout(timer.current);
      current.current = el;
      const warm = Date.now() - lastHide.current < WARM_MS || tip !== null;
      timer.current = setTimeout(() => current.current === el && show(el), warm ? 0 : DELAY);
    };
    const over = (e: PointerEvent) => enter(e.target);
    const focus = (e: FocusEvent) => {
      if ((e.target as HTMLElement).matches?.(":focus-visible")) enter(e.target);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", hide);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [tip]);

  // не выходить за края окна
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !tip) return;
    const r = el.getBoundingClientRect();
    const m = 8;
    if (r.left < m) setShift(m - r.left);
    else if (r.right > window.innerWidth - m) setShift(window.innerWidth - m - r.right);
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={boxRef}
      role="tooltip"
      className={`tooltip ${tip.below ? "below" : "above"}`}
      style={{ left: tip.x + shift, top: tip.y, ["--arrow-shift" as string]: `${-shift}px` }}
    >
      {tip.text}
    </div>
  );
}
