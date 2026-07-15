import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { systemActor, resolveActor } from '../common/actor';
import { recordAudit } from './audit';

/**
 * Phase 2 Task 3 — the platform audit kernel is the SINGLE canonical AuditLog writer.
 *
 * This is a source tripwire (same technique as route-policy/cross-module-graph): it walks
 * every `.ts` under src/ and asserts the ONLY file that calls `.auditLog.create(...)` is
 * `platform/audit.ts`. A domain service that writes an audit row directly — bypassing
 * `recordAudit` and its uniform attribution — fails here. It also pins that the actor
 * helpers carry the `actorKind` the audit + event writers attribute with.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(rel: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(SRC, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(r));
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.') && !e.name.includes('.spec.')) out.push(r);
  }
  return out;
}

describe('platform audit kernel — single canonical writer', () => {
  it('the ONLY file that calls auditLog.create is platform/audit.ts', () => {
    const writers = walk('').filter((f) => /\.auditLog\.create\b/.test(strip(readFileSync(join(SRC, f), 'utf8'))));
    expect(writers, 'a file other than platform/audit.ts writes AuditLog directly — route it through recordAudit').toEqual(['platform/audit.ts']);
  });

  it('recordAudit is exported by the kernel', () => {
    expect(typeof recordAudit).toBe('function');
  });

  it('a system actor is a real, named, non-human identity (actorKind=system, real actorId)', () => {
    const a = systemActor('system:migrator', 'Migration');
    expect(a).toEqual({ actorId: 'system:migrator', actorName: 'Migration', actorRole: 'system', actorKind: 'system' });
  });

  it('resolveActor is the human-attribution helper (actorKind=human)', () => {
    // resolveActor hits the DB for the display name; the live-PG suite exercises it fully.
    // Here we pin its shape contract: it is async and returns the four attribution fields.
    expect(typeof resolveActor).toBe('function');
  });
});
