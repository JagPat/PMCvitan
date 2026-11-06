import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PROJECT_ACCESS_CODES } from '@vitan/shared';
import { projectAccessRemoved, projectRoleChanged, projectUnavailable, ROLE_CHANGED_MESSAGES } from './lost-project';

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

  it('every role-changed message keeps its words and carries project-role-changed', () => {
    expect(Object.entries(ROLE_CHANGED_MESSAGES).map(([where]) => JSON.stringify(projectRoleChanged(where as keyof typeof ROLE_CHANGED_MESSAGES).getResponse()))).toEqual(
      Object.values(ROLE_CHANGED_MESSAGES).map((message) => JSON.stringify({ message, error: 'Forbidden', statusCode: 403, code: PROJECT_ACCESS_CODES.roleChanged })));
    expect(Object.values(ROLE_CHANGED_MESSAGES)).toEqual([
      'Project role changed; sign in again',
      'Your role on this project changed — sign in again',
      'Your role on this project has changed; sign in again',
      'Your project standing changed while approving — the role that authorized this approval is no longer yours',
      'Your project standing changed while forwarding — the role that authorized this forward is no longer yours',
      'Your project standing changed — asking for advice on this decision is a PMC or architect authority',
      'Your project standing changed — the role that allowed naming who fixes this is no longer yours',
    ]);
  });

  it('no other source file writes one of the lost-project messages, or throws STALE_ROLE_MESSAGE bare, so none can be thrown uncoded', () => {
    const messages = ['Project is unavailable', 'Project access has been removed', ...Object.values(ROLE_CHANGED_MESSAGES)];
    const writers = sources(SRC)
      .filter((path) => !path.endsWith(join('common', 'lost-project.ts')))
      .filter((path) => {
        const text = readFileSync(path, 'utf8');
        return messages.some((m) => text.includes(`'${m}'`) || text.includes(`"${m}"`) || text.includes(`\`${m}\``))
          || /ForbiddenException\(\s*STALE_ROLE_MESSAGE/.test(text);
      })
      .map((path) => relative(SRC, path));
    expect(writers).toEqual([]);
  });
});
