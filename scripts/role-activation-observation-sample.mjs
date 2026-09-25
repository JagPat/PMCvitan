/**
 * Role-transfer OBSERVATION SAMPLE.
 *
 * A small helper used only on the pull request that hosts the role transfer's one observed correction cycle
 * (docs/CLOUD_ROLE_TRANSFER.md, "Observer and the observed-cycle runbook"). That pull request is closed without
 * merging once the cycle is observed.
 */

/** Clamp a percentage to the closed range [0, 100]. Any value that is not a finite number is 0. */
export function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value > 100) return 100;
  return value;
}
