// Lineage policy shared by the review-state leaf and the review-efficiency leaf.
//
// It lives below both because both are consumed independently by the orchestration
// layer: importing it sideways from one leaf into the other would couple two
// otherwise separate policy modules.
//
// The only base a lineage obligation may be created for, claimed from, or settled
// onto. The guard reads a base REF, never ancestry: `main` advances under an open
// unit as a matter of course, and a squash merge leaves the reviewed head off the
// post-merge history by construction, so ancestry against the moving tip refuses
// ordinary valid work. See docs/reviews/replacement-lineage-repair.md.
export const LINEAGE_BASE_REF = 'main';

// A base is MUTABLE, so every placement that acts on one reads it again at its own
// moment rather than trusting an earlier read.
export function isLineageBase(ref) {
  return ref === LINEAGE_BASE_REF;
}
