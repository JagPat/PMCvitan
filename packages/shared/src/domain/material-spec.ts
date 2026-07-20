/**
 * Phase 3 Task 1 — the ONE deterministic material-specification identity (shared, both runtimes).
 *
 * `specFingerprint` hashes ONLY the normalized TECHNICAL identity of a material —
 * category, make, grade, normalized attribute text and base UOM. Decision provenance
 * (decisionId / decisionVersion / optionKey) is carried on the `MaterialSpecificationRef`
 * but NEVER hashed (round-2 review, finding 1): identical material approved by two different
 * decisions has ONE fingerprint and pools as one stock identity, while every row still
 * records which decision approved it.
 *
 * The fingerprint is SHA-256 via WebCrypto (`globalThis.crypto.subtle`) — available
 * identically in the browser and Node ≥18 — over a versioned, field-tagged canonical
 * string, so the same inputs produce the same hex on both sides by construction.
 * Quantities are DECIMAL STRINGS (never floats): `parseQuantity` validates and
 * normalizes to a canonical form that round-trips PostgreSQL `numeric(18,6)` exactly.
 */

/** The technical identity of a material — the ONLY fields the fingerprint hashes. */
export interface MaterialTechnicalIdentity {
  readonly materialCategory: string;
  readonly make: string;
  readonly grade: string;
  /** Free attribute text; normalized by {@link normalizeSpecText} before hashing/storage. */
  readonly normalizedAttributes: string;
  readonly baseUom: string;
}

/** Decision provenance — stored on the ref, NEVER part of the fingerprint. */
export interface MaterialProvenance {
  readonly decisionId: string | null;
  readonly decisionVersion: number | null;
  readonly optionKey: string | null;
}

/** Base units of measure the pilot accepts (Stage 1; additive to extend). */
export const BASE_UOMS = ['nos', 'kg', 't', 'm', 'm2', 'm3', 'l', 'bag', 'box', 'roll', 'sqft', 'cft'] as const;
export type BaseUom = (typeof BASE_UOMS)[number];

export function isBaseUom(v: string): v is BaseUom {
  return (BASE_UOMS as readonly string[]).includes(v);
}

/** Normalize free specification text: trim, collapse inner whitespace, lower-case. */
export function normalizeSpecText(v: string): string {
  return v.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Validate + canonicalize a decimal quantity STRING for `numeric(18,6)`:
 * positive, ≤ 12 integer digits, ≤ 6 fractional digits. Returns the canonical
 * form (no leading '+', no trailing fractional zeros, no leading zeros) or null
 * when invalid — the canonical form round-trips PostgreSQL byte-identically.
 */
export function parseQuantity(v: string): string | null {
  if (typeof v !== 'string' || !/^\d{1,12}(\.\d{1,6})?$/.test(v.trim())) return null;
  const [rawInt, rawFrac = ''] = v.trim().split('.');
  const int = rawInt.replace(/^0+(?=\d)/, '');
  const frac = rawFrac.replace(/0+$/, '');
  if (int === '0' && frac === '') return null; // zero (and negatives never match the regex)
  return frac ? `${int}.${frac}` : int;
}

/** The versioned canonical string the fingerprint hashes — field-tagged so reordering
 *  or concatenation collisions are impossible. EXCLUDES provenance by construction. */
export function canonicalSpecString(t: MaterialTechnicalIdentity): string {
  return [
    'msf.v1',
    `cat:${normalizeSpecText(t.materialCategory)}`,
    `make:${normalizeSpecText(t.make)}`,
    `grade:${normalizeSpecText(t.grade)}`,
    `attrs:${normalizeSpecText(t.normalizedAttributes)}`,
    `uom:${t.baseUom}`,
  ].join('\u001f'); // US field separator between tagged fields (no concatenation collisions)
}

/** SHA-256 hex over {@link canonicalSpecString} — deterministic on web and API. */
export async function computeSpecFingerprint(t: MaterialTechnicalIdentity): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalSpecString(t));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
