/**
 * Phase 6 task 4d unit 4d-ii-a / A5c — `RoleStandingQuery`, the KERNEL read of role standing (§A.2).
 *
 * 4d-i installed the platform registers the orgs-owned triggers project from `Membership` and
 * `OrgMembership` — `ProjectRoleStanding` (a count per role; 4d maintains `architect`) and
 * `ProjectUserStanding` (a row per user per role) — and the kernel SQL reads every 4d seal asks its
 * standing questions through (`platform_role_standing`, `platform_user_holds_role`,
 * `platform_role_holder_user_ids`). This is the SERVICE's handle on the same reads, so a service and
 * the seals judging it answer from one register and cannot disagree by construction; and no decisions
 * code reads an orgs table to learn who holds a role.
 *
 * Every read runs on the caller's client, so it joins the caller's transaction (and its locks).
 */
export interface KernelReadClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export const RoleStandingQuery = {
  /** How many users hold `role` on the project (`platform_role_standing`). 4d counts `architect`;
   *  `client`/`pmc` standing stays `phase6_effective_role_standing`'s (§A.2), so this is asked of the
   *  architect role only. */
  async activeCount(client: KernelReadClient, projectId: string, role: 'architect'): Promise<number> {
    const rows = await client.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT platform_role_standing($1, $2)::int AS n`, projectId, role,
    );
    return Number(rows[0]?.n ?? 0);
  },

  /** Whether `userId` holds `role` on the project (`platform_user_holds_role`, the per-user register). */
  async holdsRole(client: KernelReadClient, projectId: string, userId: string, role: string): Promise<boolean> {
    const rows = await client.$queryRawUnsafe<Array<{ holds: boolean }>>(
      `SELECT platform_user_holds_role($1, $2, $3) AS holds`, projectId, userId, role,
    );
    return rows[0]?.holds === true;
  },

  /** The users holding `role` on the project, in id order (`platform_role_holder_user_ids`). */
  async holderUserIds(client: KernelReadClient, projectId: string, role: string): Promise<string[]> {
    const rows = await client.$queryRawUnsafe<Array<{ userId: string }>>(
      `SELECT h AS "userId" FROM platform_role_holder_user_ids($1, $2) AS h`, projectId, role,
    );
    return rows.map((r) => r.userId);
  },
};
