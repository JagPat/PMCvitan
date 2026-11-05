import type { ItemGuide } from '@vitan/shared';
import type { InspectionItemSpec, InspectionRecordKind, InspectionRecordWhen, ItemGuideSpec } from '../contracts';

/**
 * Guided site inspections, step 2a — one place that turns an issued item's spec (a plain name, or a guided item) into
 * the columns the item row is INSERTED with, and an item row back into a spec or the guide a reader is served.
 *
 * Every writer that issues items goes through {@link itemRowFromSpec}: a new checklist, a re-inspection's items, and
 * project set-up from a template. The guidance must be in the INSERT, because the database never lets it be set or
 * changed afterwards (`InspectionItem_guidance_fixed`, 20280210000000), nor a guided item deleted and issued again.
 */
export interface ItemGuidanceColumns {
  lookAt: string | null;
  passRule: string | null;
  recordKind: string | null;
  recordCount: number | null;
  recordWhen: string | null;
  recordHint: string | null;
}

/** The six columns all NULL: an item issued by name only. */
const PLAIN: ItemGuidanceColumns = { lookAt: null, passRule: null, recordKind: null, recordCount: null, recordWhen: null, recordHint: null };

/** The row an item spec is inserted as: its name and its guidance columns (all NULL for a plain name). */
export function itemRowFromSpec(spec: InspectionItemSpec): { name: string } & ItemGuidanceColumns {
  if (typeof spec === 'string') return { name: spec, ...PLAIN };
  return {
    name: spec.name,
    lookAt: spec.lookAt ?? null,
    passRule: spec.passRule ?? null,
    recordKind: spec.record?.kind ?? null,
    recordCount: spec.record?.count ?? null,
    recordWhen: spec.record?.when ?? null,
    recordHint: spec.record?.hint ?? null,
  };
}

/** The guidance columns of a stored item, copied as they are (a re-inspection re-checks against the same guidance). */
export function guidanceColumnsOf(row: ItemGuidanceColumns): ItemGuidanceColumns {
  return {
    lookAt: row.lookAt ?? null,
    passRule: row.passRule ?? null,
    recordKind: row.recordKind ?? null,
    recordCount: row.recordCount ?? null,
    recordWhen: row.recordWhen ?? null,
    recordHint: row.recordHint ?? null,
  };
}

/** Whether a stored item carries any guidance (the database's own test for a guided row, `InspectionItem_guided_not_deleted`). */
export function isGuidedRow(row: ItemGuidanceColumns): boolean {
  return Object.values(guidanceColumnsOf(row)).some((v) => v !== null);
}

/** What a reader is served for an item: its guidance, or null for an item issued by name only. The record spec is
 *  whole or absent in the database (`InspectionItem_record_spec`), so a kind means a count and a when too. */
export function guideOf(stored: ItemGuidanceColumns): ItemGuide | null {
  const row = guidanceColumnsOf(stored);
  if (!isGuidedRow(row)) return null;
  return {
    lookAt: row.lookAt,
    passRule: row.passRule,
    record: row.recordKind !== null && row.recordCount !== null && row.recordWhen !== null
      ? { kind: row.recordKind as InspectionRecordKind, count: row.recordCount, when: row.recordWhen as InspectionRecordWhen, hint: row.recordHint }
      : null,
  };
}

/** A stored item as a spec a template carries: its plain name when it has no guidance, else the guided item. */
export function specFromItemRow(row: { name: string } & ItemGuidanceColumns): InspectionItemSpec {
  const guide = guideOf(row);
  if (!guide) return row.name;
  return {
    name: row.name,
    ...(guide.lookAt !== null ? { lookAt: guide.lookAt } : {}),
    ...(guide.passRule !== null ? { passRule: guide.passRule } : {}),
    ...(guide.record
      ? { record: { kind: guide.record.kind, count: guide.record.count, when: guide.record.when, ...(guide.record.hint !== null ? { hint: guide.record.hint } : {}) } }
      : {}),
  };
}

/** A template payload's checklist items as specs: each name, guided by the guide at its position when there is one. */
export function specsFromPayload(checklist: { items: string[]; guides?: Array<ItemGuideSpec | null> }): InspectionItemSpec[] {
  return checklist.items.map((name, i) => {
    const guide = checklist.guides?.[i];
    return guide ? { name, ...guide } : name;
  });
}

/** Specs as a template payload stores them: the names, and the guides beside them only when some item is guided. */
export function payloadItemsFromSpecs(specs: InspectionItemSpec[]): { items: string[]; guides?: Array<ItemGuideSpec | null> } {
  const items = specs.map((spec) => (typeof spec === 'string' ? spec : spec.name));
  if (specs.every((spec) => typeof spec === 'string')) return { items };
  return { items, guides: specs.map((spec) => (typeof spec === 'string' ? null : (({ name: _name, ...guide }) => guide)(spec))) };
}
