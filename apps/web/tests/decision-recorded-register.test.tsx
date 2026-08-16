import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { DecisionLogScreen } from '@/screens/DecisionLogScreen';
import { groupDecisions } from '@/lib/locationTree';
import type { Decision } from '@vitan/shared';

/**
 * Phase 6 unit 4b-i, ROUND 6 (Codex P1) — the register renders a RECORD as a record.
 *
 * `deciderKind: 'none'` was deliberately KEPT when round 5 gated the decider surface, so records
 * are creatable, permanent, and served to the WHOLE team. The register had no branch for them:
 * `neverLocked` covered only `pending` and `withdrawn`, so a published record fell through to the
 * approved shape and the primary surface gave a false account of every one — an outcome line read
 * off an approval that never happened, a zero approved cost, an APPROVED photo stamp, and
 * "awaiting client" for a decision nobody can ever approve. The status filter, the grouped
 * status label and the rollup header omitted the value entirely.
 *
 * RED at `ccaf2dd`: the row renders `undefined — undefined`, `APPROVED`, and `awaiting client`.
 */

const rec = (id: string): Decision =>
  ({
    id,
    title: `Site issue ${id}`,
    room: 'Kitchen',
    status: 'recorded',
    photoSwatch: 'tile',
    date: '14 Aug 2026',
    // a record carries ZERO options and no approval — that is what makes it a record
    options: [],
  }) as unknown as Decision;

const pending = (id: string): Decision =>
  ({
    id,
    title: `Choice ${id}`,
    room: 'Kitchen',
    status: 'pending',
    photoSwatch: 'tile',
    ageDays: 3,
    options: [
      { label: 'A', key: 'a', material: 'Granite', delta: 0, swatch: 'tile', recommended: true },
      { label: 'B', key: 'b', material: 'Quartz', delta: 20000, swatch: 'stone', recommended: false },
    ],
  }) as unknown as Decision;

describe('Phase 6 unit 4b-i round 6 — the register renders records truthfully', () => {
  afterEach(() => {
    cleanup();
    useStore.setState(getInitialState());
  });

  it('a published RECORD is not rendered as an approval — no fabricated outcome, cost, stamp or demand', () => {
    useStore.setState({ role: 'pmc', decisions: [rec('DL-R1'), pending('DL-P1')] });
    const { getByTestId } = render(<DecisionLogScreen />);
    const row = getByTestId('log-row-DL-R1').textContent ?? '';

    // the four falsehoods, each asserted as ABSENT
    expect(row).not.toContain('undefined');
    expect(row).not.toContain('APPROVED');
    expect(row).not.toContain('awaiting client');
    expect(row).not.toContain('Approved by');
    // `Math.max()` over an empty option list is -Infinity — the old `neverLocked` path would have
    // rendered it had the record fallen the other way
    expect(row).not.toContain('Infinity');

    // …and what it DOES say
    expect(row).toContain('RECORD');
    expect(row).toContain('no approval required');
    expect(row).toContain('RECORDED');

    // the ordinary pending row is untouched
    const other = getByTestId('log-row-DL-P1').textContent ?? '';
    expect(other).toContain('2 options presented');
    expect(other).toContain('OPTIONS');
  });

  it('every surface that enumerates statuses knows about `recorded` — filter, rollup and group label', () => {
    useStore.setState({ role: 'pmc', decisions: [rec('DL-R2'), pending('DL-P2')] });
    const { getByTestId, queryByTestId } = render(<DecisionLogScreen />);

    // the filter chip exists, and filtering by it keeps the record and drops the rest
    const chip = queryByTestId('filter-recorded');
    expect(chip, 'a status the register displays must be a status the reader can filter by').not.toBeNull();
    fireEvent.click(chip!);
    expect(queryByTestId('log-row-DL-R2')).not.toBeNull();
    expect(queryByTestId('log-row-DL-P2')).toBeNull();
    void getByTestId;
  });

  it('the grouping rollup counts records, and the status lens labels their section', () => {
    const groups = groupDecisions([rec('DL-R3'), pending('DL-P3')], [], 'status');
    const recordGroup = groups.find((g) => g.key === 'recorded');
    expect(recordGroup, 'the status lens must produce a section for a status the register serves').toBeDefined();
    expect(recordGroup!.label).toBe('Recorded');
    expect(recordGroup!.counts.recorded).toBe(1);
    // …and the section sits between approved and withdrawn: a record is settled, not retired
    expect(groups.map((g) => g.key)).toEqual(['pending', 'recorded']);
  });
});
