#!/usr/bin/env node
// EVERY MIGRATION IS MACHINE-READABLE, OR THE ONE THAT IS NOT IS NAMED.
//
// This is the foundation the migration-invariant rules will stand on, shipped as its own unit
// because it is its own claim and it can be proven without any rule existing yet:
//
//   for all 91 migrations, every SQL query in the file is either a SITE the rules can be asked
//   about, or an UNREADABLE FRAGMENT reported at its line with the reason it could not be read.
//
// WHY THAT CLAIM IS WORTH A UNIT. The rules this repository needs are checks; a check that runs
// over a corpus it has only partly read reports "clean" about SQL nobody looked at. That is not a
// gap in coverage, it is a FALSE REPORT — and it is the same shape as the defect the rules exist
// to catch, one level up. Measured on the closed lineage of this work, that happened twice in the
// same file: a PL/pgSQL `EXECUTE` counted its own string literal as a fully-parsed site, and five
// `LANGUAGE sql` function bodies were skipped by a bare `continue` and appeared in no list at all.
// Both reported total coverage. So coverage is made an executable claim BEFORE any rule reads it.
//
// WHAT THIS UNIT DELIBERATELY DOES NOT SHIP. No rule, and therefore no exemption ledger — an
// exemption exists only to record a judged finding, and nothing here judges anything.
// docs/MIGRATION_INVARIANTS.md names the rules that are deferred, the branch whose history is
// their handover, and the two LIVE DEFECTS that no check in this repository currently detects.
// Deferring a rule does not unfind its defect; it removes the alarm, and that is written down.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadParser, parseMigration } from './pg-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'apps', 'api', 'prisma', 'migrations');

export function migrationNames(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).sort().filter((n) => existsSync(join(dir, n, 'migration.sql')));
}

/**
 * Read the whole corpus and account for every part of it.
 *
 * A file the grammar refuses at all THROWS, naming the file — this adapter never degrades to
 * "found nothing". Everything it can open is returned as counted sites and named fragments.
 */
export function readCorpus({ dir = MIGRATIONS_DIR } = {}) {
  const migrations = migrationNames(dir);
  let sites = 0;
  let routines = 0;
  const unreadable = [];
  for (const name of migrations) {
    const parsed = parseMigration(readFileSync(join(dir, name, 'migration.sql'), 'utf8'));
    sites += parsed.sites.length;
    routines += parsed.routines.length;
    for (const u of parsed.unreadable) unreadable.push({ migration: name, ...u });
  }
  return { migrations: migrations.length, routines, sites, unreadable };
}

/** One line per unreadable fragment, in the order a reader would open them. */
export const describe = (u) => `${u.migration}/migration.sql:${u.line}  ${u.kind}  `
  + `${String(u.detail ?? '').replace(/\s+/gu, ' ').slice(0, 100)}`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadParser();
  const corpus = readCorpus();
  // The fragments are printed on EVERY run, not only on failure. What a checker cannot read is
  // part of its result, and burying it until something breaks is how it stops being noticed.
  for (const u of corpus.unreadable) console.error(describe(u));
  if (corpus.unreadable.length > 0) console.error('');
  console.log(`migration-readability: ${corpus.migrations} migrations, ${corpus.routines} routines, `
    + `${corpus.sites} sites, ${corpus.unreadable.length} unreadable fragment`
    + `${corpus.unreadable.length === 1 ? '' : 's'}${corpus.unreadable.length > 0 ? ' printed above' : ''}.`);
}
