/**
 * Phase 6 task 4d unit 4d-ii-a / A3a — the provisioning roster `prisma/ensure-accounts.ts` writes,
 * validated WHOLE before its first write.
 *
 * `ensure-accounts` (the manual command and the `AUTO_ENSURE_ACCOUNTS=true` boot path) creates a
 * `User` from each `ACCOUNTS_JSON` entry and then upserts its `Membership`. An `architect` entry
 * would pass the `User` write and be refused at the membership by 4d-i's reservation door,
 * failing provisioning with the user left behind. Architect standing is a product act of the PMC
 * through the ledgered member commands, never a provisioning default (plan §A.1, P28b), so the
 * roster refuses an `architect` entry — and the script refuses a legacy `User.role` of
 * `architect` in its membership backfill — BEFORE anything is written.
 *
 * Only `architect` is refused by role. The roster's other roles are whatever the deployment's
 * `ACCOUNTS_JSON` names, and widening the refusal to "the four the default roster uses" would turn
 * a valid file (a `consultant`, say) into a new boot failure.
 */

/** One account the roster provisions. `role` is the membership role it is granted on the project. */
export interface AccountSpec {
  role: string;
  name: string;
  email?: string;
  phone?: string;
}

/** The roles provisioning may never grant; `architect` is reserved to the ledgered commands. */
export const PROVISIONING_REFUSED_ROLES: readonly string[] = ['architect'];

/** A roster refused before any write, naming every entry at fault. */
export class AccountRosterError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`ensure-accounts: the roster is refused and NOTHING was written —\n  ${problems.join('\n  ')}`);
    this.name = 'AccountRosterError';
  }
}

const describe = (a: Partial<AccountSpec>, index: number): string =>
  `entry #${index + 1} (${[a.name, a.email ?? a.phone].filter(Boolean).join(', ') || 'unnamed'})`;

/**
 * Parse and validate the roster. `raw` is `ACCOUNTS_JSON`; absent, `defaults` is the roster.
 * Throws {@link AccountRosterError} listing every refused entry, so an operator fixes the file in
 * one pass. An entry with neither an email nor a phone is not an error here: the script skips it
 * with a warning, as it always has.
 */
export function parseAccountRoster(raw: string | undefined, defaults: readonly AccountSpec[]): AccountSpec[] {
  let value: unknown = defaults;
  if (raw !== undefined && raw.trim() !== '') {
    try {
      value = JSON.parse(raw);
    } catch (e) {
      throw new AccountRosterError([`ACCOUNTS_JSON is not valid JSON: ${(e as Error).message}`]);
    }
  }
  if (!Array.isArray(value)) throw new AccountRosterError(['ACCOUNTS_JSON must be a JSON array of accounts']);

  const problems: string[] = [];
  value.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`entry #${index + 1} is not an object`);
      return;
    }
    const a = entry as Partial<AccountSpec>;
    if (typeof a.role !== 'string' || a.role.trim() === '') {
      problems.push(`${describe(a, index)} has no role`);
    } else if (PROVISIONING_REFUSED_ROLES.includes(a.role)) {
      problems.push(
        `${describe(a, index)} has role "${a.role}" — architect standing is granted by the PMC through the member commands, never by provisioning`,
      );
    }
    if (typeof a.name !== 'string' || a.name.trim() === '') problems.push(`${describe(a, index)} has no name`);
  });
  if (problems.length > 0) throw new AccountRosterError(problems);
  return value as AccountSpec[];
}

/**
 * The legacy-membership backfill's refusal: a pre-membership account whose `User.role` is a
 * refused role would be granted that role as a membership. Named, before any write.
 */
export function refusedBackfillProblems(
  users: ReadonlyArray<{ id: string; role: string; email: string | null; phone: string | null }>,
): string[] {
  return users
    .filter((u) => PROVISIONING_REFUSED_ROLES.includes(u.role))
    .map((u) => `legacy user ${u.email ?? u.phone ?? u.id} has User.role "${u.role}" and no membership — the backfill would grant it; set a delivered role or add them through the member commands`);
}
