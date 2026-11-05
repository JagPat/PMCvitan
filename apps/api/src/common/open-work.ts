/**
 * Redbracket ID A4b-2 — open work still named on an account, per project: userId → projectId → count. Each owning
 * module answers its own kind through its participant (`openWorkOf`), so the operator door's list of retired accounts
 * never reads another module's tables.
 */
export type OpenWorkCounts = Map<string, Map<string, number>>;

/** Count one open item named on `userId` in `projectId`. */
export function tallyOpenWork(counts: OpenWorkCounts, userId: string, projectId: string): void {
  const perProject = counts.get(userId) ?? new Map<string, number>();
  perProject.set(projectId, (perProject.get(projectId) ?? 0) + 1);
  counts.set(userId, perProject);
}
