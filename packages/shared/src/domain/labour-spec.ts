/**
 * Phase 4 Task 1 — the ONE deterministic labour-specification identity (shared, both runtimes).
 *
 * `labourSpecFingerprint` hashes ONLY the normalized TECHNICAL identity of a labour demand —
 * trade, skill and shift (plan §B). Decision provenance (decisionId / decisionVersion /
 * optionKey) is carried on the labour requirement spec but NEVER hashed (the material-spec
 * round-2 rule verbatim): identical trade/skill/shift approved by two different decisions has
 * ONE fingerprint and pools as one capacity identity, while every row still records which
 * decision approved it.
 *
 * The fingerprint is SHA-256 via WebCrypto (`globalThis.crypto.subtle`) — available
 * identically in the browser and Node ≥18 — over a versioned, field-tagged canonical string,
 * so the same inputs produce the same hex on both sides by construction. This is the exact
 * `computeSpecFingerprint` shape from `material-spec.ts`, re-homed to labour identity.
 */

/** The shifts the pilot recognises (Stage 1; additive to extend). */
export const LABOUR_SHIFTS = ['day', 'night'] as const;
export type LabourShift = (typeof LABOUR_SHIFTS)[number];

export function isLabourShift(v: string): v is LabourShift {
  return (LABOUR_SHIFTS as readonly string[]).includes(v);
}

/** The technical identity of a labour demand — the ONLY fields the fingerprint hashes.
 *  `skillCode` is optional (a bare-trade demand); it participates in the hash as an empty
 *  tag when absent, so "mason / no-skill / day" and "mason / <skill> / day" never collide. */
export interface LabourTechnicalIdentity {
  readonly tradeCode: string;
  readonly skillCode: string | null;
  readonly shift: LabourShift;
}

/** Decision provenance — stored on the labour requirement spec, NEVER part of the fingerprint. */
export interface LabourProvenance {
  readonly decisionId: string | null;
  readonly decisionVersion: number | null;
  readonly optionKey: string | null;
}

/** Normalize a labour code (trade/skill): trim, collapse inner whitespace, lower-case —
 *  the `normalizeSpecText` rule from material-spec, so identity is case/whitespace stable. */
export function normalizeLabourCode(v: string): string {
  return v.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The versioned canonical string the fingerprint hashes — field-tagged with the US field
 *  separator so reordering or concatenation collisions are impossible. EXCLUDES provenance. */
export function canonicalLabourSpecString(t: LabourTechnicalIdentity): string {
  return [
    'lsf.v1',
    `trade:${normalizeLabourCode(t.tradeCode)}`,
    `skill:${t.skillCode == null ? '' : normalizeLabourCode(t.skillCode)}`,
    `shift:${t.shift}`,
  ].join('');
}

/** SHA-256 hex over {@link canonicalLabourSpecString} — deterministic on web and API. */
export async function computeLabourSpecFingerprint(t: LabourTechnicalIdentity): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalLabourSpecString(t));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
