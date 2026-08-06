import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The two SOURCE enumerations of the `raisedBy` label set, read from the files that own them.
 *
 * There is a third enumeration — the live `BudgetException_raisedBy_check` — and it is the
 * AUTHORITY. It is deliberately not readable from here: the PR #287 convergence audit records why
 * migration text cannot answer what PostgreSQL currently enforces, so the live set is read from
 * `pg_constraint` by `test/integration/commercial-catalog-closure.test.ts`.
 *
 * These readers live in one module, rather than being re-derived in each closure, for the reason
 * the closures exist: a set written down in more than one place drifts.
 */
const HERE = join(__dirname);

const labelsIn = (text: string): string[] =>
  [...text.replace(/\/\/.*$/gmu, '').matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!).sort();

/** `BudgetExceptionDto.raisedBy` — what every client is told the server can return. */
export const dtoRaisedByLabels = (): string[] => {
  const contract = readFileSync(
    join(HERE, '..', '..', '..', '..', 'packages', 'shared', 'src', 'contracts', 'commercial.ts'),
    'utf8',
  );
  const union = /\n\s*raisedBy:\s*([^;]+);/u.exec(contract);
  if (!union) throw new Error('BudgetExceptionDto.raisedBy not found in the shared contract');
  return labelsIn(union[1]!);
};

/** `HeadroomMover` — the labels a write can actually produce. */
export const writerRaisedByLabels = (): string[] => {
  const service = readFileSync(join(HERE, 'commercial-budget.service.ts'), 'utf8');
  const union = /export type HeadroomMover =([\s\S]*?);/u.exec(service);
  if (!union) throw new Error('HeadroomMover not found in commercial-budget.service.ts');
  return labelsIn(union[1]!);
};
