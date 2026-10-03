// Базовые элементы управления в стиле Fluent: подписи, подсказки, доступность с клавиатуры.
import { useId, type ReactNode } from "react";
import type React from "react";
import { Info } from "lucide-react";

export function Field({ label, hint, children, inline }: { label: string; hint?: string; children: ReactNode; inline?: boolean }) {
  return (
    <div className={inline ? "field inline" : "field"}>
      <div className="field-label">
        <span>{label}</span>
        {hint && (
          <span className="hint-icon" data-tip={hint} aria-label={hint} tabIndex={0}>
            <Info size={13} />
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled, tip }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean; tip?: string }) {
  const id = useId();
  return (
    <label className={`toggle ${disabled ? "disabled" : ""}`} htmlFor={id} data-tip={tip}>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden />
      <span className="toggle-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step,
  format,
  label,
  hint,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  label: string;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="slider">
        <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(parseFloat(e.target.value))} />
        <output>{format ? format(value) : value}</output>
      </div>
    </Field>
  );
}

export function Select<T extends string>({ value, onChange, options, label, hint }: { value: T; onChange: (v: T) => void; options: [T, string][]; label: string; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string][]; label?: string }) {
  // стрелки ← → переключают вариант, как в стандартных переключателях Windows
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = options.findIndex(([v]) => v === value);
    const next = options[(i + d + options.length) % options.length];
    onChange(next[0]);
    const btns = e.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    btns[(i + d + options.length) % options.length]?.focus();
  };
  const seg = (
    <div className="segmented" role="radiogroup" aria-label={label || undefined} onKeyDown={onKey}>
      {options.map(([v, t]) => (
        <button key={v} role="radio" aria-checked={value === v} tabIndex={value === v ? 0 : -1} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {t}
        </button>
      ))}
    </div>
  );
  return label ? <Field label={label}>{seg}</Field> : seg;
}

export function TextInput({
  value,
  onChange,
  label,
  hint,
  placeholder,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  hint?: string;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <Field label={label} hint={hint}>
      <input type="text" value={value} placeholder={placeholder} maxLength={maxLength} aria-label={label} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
