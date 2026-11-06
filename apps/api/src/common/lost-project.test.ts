import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PROJECT_ACCESS_CODES } from '@vitan/shared';
import { projectAccessRemoved, projectRoleChanged, projectUnavailable } from './lost-project';

const SRC = join(__dirname, '..');
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const path = join(dir, e.name);
  if (e.isDirectory()) return sources(path);
  return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
});

describe('#1373: the lost-project 403s are made in one place', () => {
  it('each helper sends Nest\'s default 403 body, in its key order, plus its code', () => {
    expect([projectUnavailable(), projectRoleChanged(), projectAccessRemoved()].map((e) => [e.getStatus(), e.message, JSON.stringify(e.getResponse())])).toEqual([
      [403, 'Project is unavailable', JSON.stringify({ message: 'Project is unavailable', error: 'Forbidden', statusCode: 403, code: PROJECT_ACCESS_CODES.unavailable })],
      [403, 'Project role changed; sign in again', JSON.stringify({ message: 'Project role changed; sign in again', error: 'Forbidden', statusCode: 403, code: PROJECT_ACCESS_CODES.roleChanged })],
      [403, 'Project access has been removed', JSON.stringify({ message: 'Project access has been removed', error: 'Forbidden', statusCode: 403, code: PROJECT_ACCESS_CODES.accessRemoved })],
    ]);
  });

  it('no other source file writes one of the three messages, so none can be thrown uncoded', () => {
    const messages = ['Project is unavailable', 'Project role changed; sign in again', 'Project access has been removed'];
    const writers = sources(SRC)
      .filter((path) => !path.endsWith(join('common', 'lost-project.ts')))
      .filter((path) => { const text = readFileSync(path, 'utf8'); return messages.some((m) => text.includes(`'${m}'`) || text.includes(`"${m}"`) || text.includes(`\`${m}\``)); })
      .map((path) => relative(SRC, path));
    expect(writers).toEqual([]);
  });
});
