import { isLibraryChecklistPayload, modulePayloadSchema, type InspectionItemSpec } from '../contracts';
import { specsFromPayload } from '../inspections/guided-item';

/**
 * Guided site inspections, step 2c — the Vitan checklist library (proposal decision 4, Jagrut 5 Nov 2026: "one Vitan
 * library, which the PMC copies per project").
 *
 * A library checklist is an org module of category {@link LIBRARY_CHECKLIST_CATEGORY}: one checklist, its items' guidance
 * and its work type, and nothing else (`isLibraryChecklistPayload`). A project's PMC reads its org's library
 * (`OrgsParticipant.checklistLibrary`) and issues a copy through the ordinary create, so the library entry never
 * changes when the copy does. It is never placed by a project template: the module menu leaves it out, and project
 * creation and preset save refuse it.
 */
export const LIBRARY_CHECKLIST_CATEGORY = 'checklist';

/** What a reader is served for one library checklist. `items` are specs as the create takes them. */
export interface LibraryChecklist {
  id: string;
  name: string;
  description: string;
  title: string;
  workType: string | null;
  items: InspectionItemSpec[];
}

/** A stored library module as its entry; null for a row whose payload is not a library checklist (never served). */
export function libraryChecklistOf(m: { id: string; name: string; description: string; payload: unknown }): LibraryChecklist | null {
  const parsed = modulePayloadSchema.safeParse(m.payload ?? {});
  if (!parsed.success || !isLibraryChecklistPayload(parsed.data)) return null;
  const c = parsed.data.inspections[0]!;
  return { id: m.id, name: m.name, description: m.description, title: c.title, workType: c.workType ?? null, items: specsFromPayload(c) };
}
