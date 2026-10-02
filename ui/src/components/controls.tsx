// Базовые элементы управления в стиле Fluent: подписи, подсказки, доступность с клавиатуры.
import { useId, type ReactNode } from "react";
import { Info } from "lucide-react";

export function Field({ label, hint, children, inline }: { label: string; hint?: string; children: ReactNode; inline?: boolean }) {
  return (
    <div className={inline ? "field inline" : "field"}>
      <div className="field-label">
        <span>{label}</span>
        {hint && (
          <span className="hint-icon" title={hint} aria-label={hint}>
            <Info size={13} />
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <label className={`toggle ${disabled ? "disabled" : ""}`} htmlFor={id} title={hint}>
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
  const seg = (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([v, t]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
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
