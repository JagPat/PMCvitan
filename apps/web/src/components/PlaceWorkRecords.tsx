import type { ReactNode } from 'react';

/** One kind of record the place holds: its rows (or an empty line) under a titled, counted heading. */
export interface PlaceRecordSection {
  /** stable id: the section's test id is `place-section-<key>` */
  key: string;
  icon: ReactNode;
  title: string;
  count: number;
  sub: string;
  body: ReactNode;
}

/**
 * #633 (mockup 7) — "Work and records here": everything filed at the place on show, one titled
 * section per kind of record, each row opening its own record. The screen decides which sections a
 * viewer gets and in what order; a later kind of record is one more entry in `sections`.
 */
export function PlaceWorkRecords({ where, sections }: { where: string; sections: PlaceRecordSection[] }) {
  return (
    <section data-testid="place-work-records" aria-labelledby="place-work-records-title" style={{ marginTop: 4 }}>
      <h2 id="place-work-records-title" style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Work and records here</h2>
      <div data-testid="place-work-records-where" style={{ fontSize: 12.5, color: 'var(--muted)', margin: '2px 0 14px' }}>{where}</div>
      {sections.map((s) => (
        <div key={s.key} data-testid={`place-section-${s.key}`} style={{ marginBottom: 22 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <h3 style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 14.5, margin: 0 }}>{s.icon} {s.title}</h3>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--faint)' }}>{s.count}</span>
            <span style={{ fontSize: 12, color: 'var(--faint)', marginLeft: 'auto' }}>{s.sub}</span>
          </div>
          {s.body}
        </div>
      ))}
    </section>
  );
}

/** The one line a section shows when the place holds none of its records. */
export function PlaceRecordsEmpty({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12.5, color: 'var(--faint)', padding: '6px 0' }}>{children}</div>;
}
