import { useId, useRef, useState, type CSSProperties } from 'react';
import { parseCivilDate } from '@vitan/shared';

/**
 * #827 (approved mockup "PlanDates") — a real date picker in place of typed day numbers. The field
 * shows the chosen day ("Tue 20 Oct 2026"); tapping it opens a month calendar under it. Values are ISO
 * civil dates (YYYY-MM-DD), the unit the API stores, so no timezone ever shifts a day: every label is
 * formatted in UTC from the civil date itself.
 *
 * `min` disables the days before it (a plan cannot start before the schedule does). Every day is a real
 * button with its full date as its name, so a keyboard or screen-reader user picks a day the same way.
 */

const FIELD_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const DAY_NAME_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const MONTH_FMT = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "Tue 20 Oct 2026" — the field's text for a civil date. */
export function pickerLabel(iso: string): string {
  return FIELD_FMT.format(parseCivilDate(iso)).replace(',', '');
}

const pad = (n: number) => String(n).padStart(2, '0');
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;

/** The month's day cells, Monday first: leading blanks, then each day as an ISO date. */
function monthCells(firstOfMonth: string): Array<string | null> {
  const first = parseCivilDate(firstOfMonth);
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  const days = Math.round((next.getTime() - first.getTime()) / 86_400_000);
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${firstOfMonth.slice(0, 8)}${pad(d)}`);
  return cells;
}

function shiftMonth(firstOfMonth: string, by: number): string {
  const d = parseCivilDate(firstOfMonth);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + by, 1)).toISOString().slice(0, 10);
}

const fieldStyle: CSSProperties = {
  width: '100%', minHeight: 44, padding: '10px 12px', borderRadius: 9, border: '1px solid rgba(35,33,28,.2)',
  background: '#fff', color: 'var(--ink)', fontSize: 14, fontFamily: 'var(--font-sans)', textAlign: 'left', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
};
const navStyle: CSSProperties = {
  minWidth: 44, minHeight: 44, border: 'none', background: 'transparent', fontSize: 20, color: 'var(--ink)', cursor: 'pointer',
};

export function DatePicker({
  label,
  value,
  onChange,
  min,
  today,
  testId,
}: {
  label: string;
  value: string;
  onChange: (iso: string) => void;
  min?: string;
  today?: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => monthStart(value));
  // a value changed from outside (the start moving the end) brings its month into view
  const [shownValue, setShownValue] = useState(value);
  if (shownValue !== value) {
    setShownValue(value);
    setMonth(monthStart(value));
  }
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const cells = monthCells(month);
  const canGoBack = !min || shiftMonth(month, -1) >= monthStart(min);

  return (
    // an open calendar takes the whole row, so its days stay tappable on a phone
    <div style={{ flex: open ? '1 1 100%' : '1 1 0', minWidth: 0 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      <button
        ref={toggleRef}
        type="button"
        onClick={() => { setMonth(monthStart(value)); setOpen((o) => !o); }}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${label}: ${pickerLabel(value)}`}
        data-testid={testId}
        style={{ ...fieldStyle, ...(open ? { border: '2px solid var(--accent)' } : {}) }}
      >
        <span>{pickerLabel(value)}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div id={panelId} role="group" aria-label={`${label} calendar`} data-testid={`${testId}-calendar`}
          style={{ marginTop: 8, borderRadius: 12, background: '#fff', border: '1px solid rgba(35,33,28,.12)', padding: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button type="button" aria-label="Previous month" disabled={!canGoBack} onClick={() => setMonth((m) => shiftMonth(m, -1))}
              style={{ ...navStyle, opacity: canGoBack ? 1 : 0.3 }}>‹</button>
            <div style={{ fontWeight: 700, fontSize: 14 }} aria-live="polite">{MONTH_FMT.format(parseCivilDate(month))}</div>
            <button type="button" aria-label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))} style={navStyle}>›</button>
          </div>
          <div aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', textAlign: 'center', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>
            {WEEKDAYS.map((w) => <div key={w}>{w}</div>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 2, marginTop: 4 }}>
            {cells.map((iso, i) => {
              if (!iso) return <div key={`b${i}`} />;
              const selected = iso === value;
              const disabled = !!min && iso < min;
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  aria-label={DAY_NAME_FMT.format(parseCivilDate(iso))}
                  aria-current={iso === today ? 'date' : undefined}
                  onClick={() => { onChange(iso); setOpen(false); toggleRef.current?.focus(); }}
                  data-testid={`${testId}-day-${iso}`}
                  style={{
                    minHeight: 44, borderRadius: 8, border: 'none', fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-sans)',
                    cursor: disabled ? 'default' : 'pointer',
                    background: selected ? 'var(--accent)' : 'transparent',
                    color: selected ? '#fff' : disabled ? 'rgba(35,33,28,.3)' : 'var(--ink)',
                    boxShadow: iso === today && !selected ? 'inset 0 0 0 2px var(--ink)' : undefined,
                  }}
                >
                  {Number(iso.slice(8))}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Whole days a plan covers, both ends included ("6 days" for Tue 20 → Sun 25). */
export function inclusiveDays(start: string, end: string): number {
  return Math.round((parseCivilDate(end).getTime() - parseCivilDate(start).getTime()) / 86_400_000) + 1;
}
