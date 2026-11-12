import { useEffect, useId, useRef, useState } from "react";

export type Option<V extends string | number> = { value: V; label: string };

/** Custom dropdown with viewport-aware placement so pickers never clip offscreen on mobile. */
export default function Select<V extends string | number>({
  value, options, onChange, className = "", label, icon, compact, disabled,
}: {
  value: V;
  options: Option<V>[];
  onChange: (v: V) => void;
  className?: string;
  label?: string;
  icon?: React.ReactNode;
  /** small pill for the top bar instead of a full-width form field */
  compact?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [flipUp, setFlipUp] = useState(false);
  const [alignLeft, setAlignLeft] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const cur = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const rect = root.current?.getBoundingClientRect();
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setFlipUp(spaceBelow < 220 && spaceAbove > spaceBelow);
      if (compact) {
        // compact defaults right:0; flip left-aligned if menu width would clip past viewport left edge
        setAlignLeft(rect.right < 176);
      } else {
        setAlignLeft(rect.left + 180 > window.innerWidth);
      }
    }
    const off = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open, compact]);

  const pick = (v: V) => { setOpen(false); if (v !== value) onChange(v); };
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const i = active < 0 ? Math.max(0, options.findIndex((o) => o.value === value)) : active;
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(i); return; }
      setActive((i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if ((e.key === "Enter" || e.key === " ") && open && active >= 0) {
      e.preventDefault();
      pick(options[active].value);
    }
  };

  return (
    <div className={`dd${compact ? " dd-c" : ""}`} ref={root} onKeyDown={onKey}>
      <button
        type="button"
        disabled={disabled}
        className={`dd-btn ${compact ? "" : className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => { if (!disabled) { setOpen((o) => !o); setActive(-1); } }}
      >
        {icon}
        <span className="dd-cur">{cur?.label}</span>
        <svg className="dd-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <ul className={`dd-menu${flipUp ? " dd-up" : ""}${alignLeft ? " dd-left" : ""}`} id={id} role="listbox">
          {options.map((o, i) => (
            <li key={String(o.value)}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={i === active ? "act" : ""}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
