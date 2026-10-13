import { describe, it, expect } from 'vitest';
import { noticeText, type Lang } from '@vitan/shared';
import {
  pendingDecisionNotice,
  withdrawnDecisionNotice,
  recordedDecisionNotice,
  approvedDecisionNotice,
  changeRequestedNotice,
  forwardedDecisionNotice,
  provisionalApprovalNotice,
  finalizedApprovalNotice,
  DESIGNATION_ROLE_LABEL,
  type ApprovedDecisionNoticeFacts,
} from './notifications';

/**
 * #827 (Top 10 #5, the bell) — every notice this server writes reads in Hindi and Gujarati in the bell.
 * The decision notices are built here with the writers' OWN functions, so a change to a template that the
 * bell's translation does not know fails this test instead of quietly showing English. The other writers
 * compose their text inline; their shapes are copied below from the writer named beside each.
 */

// quoted data: names, titles, reasons, materials, ids and dates are shown as written
const DATA = ['Client', 'Kitchen Counter', 'Quartz', 'Ar Meghna', 'Rohan Shah', 'Too costly', 'INSP', 'DL', 'Granite', 'Slab casting', 'Ground floor', 'Jun', 'PMC', 'Terrace', 'Rev'];
const latin = (s: string): string[] => {
  const allow = new Set(DATA.flatMap((d) => d.match(/[A-Za-z]+/g) ?? []));
  return (s.match(/[A-Za-z]{2,}/g) ?? []).filter((w) => !allow.has(w));
};

const facts = (over: Partial<ApprovedDecisionNoticeFacts> = {}): ApprovedDecisionNoticeFacts => ({
  actorName: 'Rohan Shah', actorRole: 'client', title: 'Kitchen Counter', material: 'Quartz', deciderKind: 'client', onBehalfOf: null, ...over,
});

// the third field: the stamps the writer puts on the notice (its decision, its inspection)
type Stamps = { decision?: boolean; inspection?: boolean };
const D: Stamps = { decision: true };
const SERVER_NOTICES: [string, string, Stamps?][] = [
  ['pending', pendingDecisionNotice('Kitchen Counter')],
  ['withdrawn', withdrawnDecisionNotice('Kitchen Counter', 'Too costly')],
  ['recorded', recordedDecisionNotice('Kitchen Counter')],
  ['approved by the client', approvedDecisionNotice(facts()), D],
  ['approved by a named decider', approvedDecisionNotice(facts({ deciderKind: 'member' })), D],
  ['approved on behalf of the client', approvedDecisionNotice(facts({ actorName: 'Ar Meghna', actorRole: 'pmc', onBehalfOf: 'client' })), D],
  ['approved on behalf of a named decider', approvedDecisionNotice(facts({ actorName: 'Ar Meghna', actorRole: 'pmc', onBehalfOf: 'member' })), D],
  ['change requested', changeRequestedNotice('Kitchen Counter', 'Too costly')],
  ...(['client', 'pmc', 'architect'] as const).map((r): [string, string, Stamps] => [`forwarded to ${r}`, forwardedDecisionNotice('Kitchen Counter', DESIGNATION_ROLE_LABEL[r]), D]),
  ['forwarded to a person', forwardedDecisionNotice('Kitchen Counter', 'Rohan Shah'), D],
  ['provisional approval', provisionalApprovalNotice(facts({ deciderKind: 'member' })), D],
  ['countersigned', finalizedApprovalNotice(facts(), 'countersign', 'Ar Meghna'), D],
  ['finalized with no architect', finalizedApprovalNotice(facts(), 'stranded_completed', 'Ar Meghna'), D],
  // inspections.service.ts
  ['checklist issued', 'New checklist issued: Slab casting — Ground floor'],
  ['inspection approved', 'Inspection INSP-4 approved. Contractor and client notified.'],
  ['signed off', 'Signed off: Slab casting is complete.'],
  ['re-inspection', 'Re-inspection INSP-5 created for 2 item(s) — due 04 Jun 2026.'],
  // activities.service.ts
  ['sign-off requested', "Sign-off requested: Slab casting — awaiting the PMC's closing inspection", { inspection: true }],
  // daily-log.service.ts
  ['material mismatch', 'Material mismatch: Granite ≠ approved DL-2'],
  ['mismatch resolved', 'Mismatch resolved: Granite — Too costly'],
  // drawings.service.ts (push bodies)
  ['drawing issued', 'Drawing issued: A-101 Rev 2 — Ground floor'],
  ['building to', 'Rohan Shah is building to A-101 Rev 2'],
];

describe('the bell shows every server notice in Hindi and Gujarati', () => {
  for (const lang of ['hi', 'gu'] as Lang[]) {
    for (const [name, text, stamps] of SERVER_NOTICES) {
      it(`${lang}, ${name}`, () => {
        const shown = noticeText(text, lang, stamps);
        const lead = text.startsWith('Decision forwarded: ') ? 'Decision forwarded: ' : stamps?.decision ? ' approved ' : undefined;
        if (!lead) {
          expect(latin(shown)).toEqual([]);
          return;
        }
        // an approval or a forward: the lead-in is translated, everything after it is shown as written (#839)
        const tail = text.slice(text.indexOf(lead) + lead.length);
        expect(shown.endsWith(`: ${tail}`)).toBe(true);
        expect(latin(shown.slice(0, -tail.length))).toEqual([]);
      });
    }
  }

  it('English is the stored text, unchanged', () => {
    for (const [, text] of SERVER_NOTICES) expect(noticeText(text, 'en')).toBe(text);
  });

  it('a title or reason containing a dash or "approved" is kept whole and in order', () => {
    const tricky = withdrawnDecisionNotice('Bath — approved tiles', 'Client — rethink');
    const shown = noticeText(tricky, 'hi');
    expect(shown.endsWith('Bath — approved tiles — Client — rethink')).toBe(true);
  });

  it('a notice no template knows is shown as stored, never guessed at', () => {
    expect(noticeText('Something new happened', 'hi')).toBe('Something new happened');
  });

  it('a material that imitates an approval ending is shown as written, never read as that ending (Codex 4264170648)', () => {
    for (const material of ['Oak — countersigned by Supplier', "Oak — awaiting the architect's countersign", 'Oak (on behalf of the client)']) {
      const text = approvedDecisionNotice(facts({ material }));
      for (const lang of ['hi', 'gu'] as const) {
        const shown = noticeText(text, lang, { decision: true });
        expect(shown.endsWith(`: Kitchen Counter — ${material}`)).toBe(true);
      }
    }
  });

  it('a member named like a role keeps their name when a decision is forwarded to them (Codex 4264702275)', () => {
    const text = forwardedDecisionNotice('Kitchen Counter', 'the client');
    expect(noticeText(text, 'hi', D).endsWith(': Kitchen Counter → the client')).toBe(true);
    expect(noticeText(text, 'gu', D).endsWith(': Kitchen Counter → the client')).toBe(true);
  });

  it("an unstamped sign-off whose activity name imitates the closing ending keeps the name whole (Codex 4264702263)", () => {
    // the demo store's writer: no ending, no inspection stamp
    const text = "Sign-off requested: Roof — awaiting the PMC's closing inspection";
    expect(noticeText(text, 'hi').endsWith(": Roof — awaiting the PMC's closing inspection")).toBe(true);
    // the server's writer stamps the closing inspection and adds the ending once, after the name
    const server = "Sign-off requested: Roof — awaiting the PMC's closing inspection — awaiting the PMC's closing inspection";
    expect(noticeText(server, 'hi', { inspection: true })).toContain(": Roof — awaiting the PMC's closing inspection — PMC");
  });

  it('the seeded client approval, which carries no stamp, is translated (Codex 4264702283)', () => {
    const seeded = 'Client approved Master Bath CP Fittings — Kohler';
    expect(noticeText(seeded, 'hi')).toBe('Client ने मंज़ूरी दी: Master Bath CP Fittings — Kohler');
    expect(noticeText(seeded, 'gu')).toBe('Client એ મંજૂરી આપી: Master Bath CP Fittings — Kohler');
  });

  it('an unstamped text that says "approved" or "is building to" is not read as an approval or a drawing (Codex 4264170661)', () => {
    for (const text of ['Budget approved by Board — archived', 'The team is building to a deadline']) {
      expect(noticeText(text, 'hi')).toBe(text);
      expect(noticeText(text, 'gu')).toBe(text);
    }
    // the same approval text, stamped with its decision, is translated
    const named = approvedDecisionNotice(facts({ deciderKind: 'member' }));
    expect(noticeText(named, 'hi')).toBe(named);
    expect(noticeText(named, 'hi', D)).not.toBe(named);
  });
});
