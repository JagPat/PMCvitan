import { describe, expect, it } from 'vitest';
import { checklistPath, decisionPath } from './record-paths';
import { drawingPath } from '../drawings/drawings.service';

/** Top 10 #3b (#774) — the web routes a push opens (apps/web lib/screens.ts `pathForScreen`), encoded. */
describe('record paths', () => {
  it('builds the decision, checklist and drawing routes, each id encoded', () => {
    expect(decisionPath('ambli', 'DL-014')).toBe('/projects/ambli/decisions/DL-014');
    expect(checklistPath('ambli', 'INSP-22')).toBe('/projects/ambli/site/checklist/INSP-22');
    expect(drawingPath('ambli', 'd1')).toBe('/projects/ambli/drawings/d1');
    expect(decisionPath('a b', 'x/y')).toBe('/projects/a%20b/decisions/x%2Fy');
  });
});
