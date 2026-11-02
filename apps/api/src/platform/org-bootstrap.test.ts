import { describe, it, expect } from 'vitest';
import { bootstrapSpecSchema, parseBootstrapArgs } from './org-bootstrap';

describe('org:bootstrap — command line and spec', () => {
  it('takes exactly --spec <path> and an optional --commit', () => {
    expect(parseBootstrapArgs(['--spec', 'a.json'])).toEqual({ specPath: 'a.json', commit: false, wrong: false });
    expect(parseBootstrapArgs(['--commit', '--spec', 'a.json'])).toEqual({ specPath: 'a.json', commit: true, wrong: false });
  });

  it('calls a misspelled flag, a stray word, a repeat or a missing path wrong, never a dry run', () => {
    expect(parseBootstrapArgs(['--spec', 'a.json', '--commmit']).wrong).toBe(true);
    expect(parseBootstrapArgs(['--spec', 'a.json', 'commit']).wrong).toBe(true);
    expect(parseBootstrapArgs(['--spec', 'a.json', '--commit', '--commit']).wrong).toBe(true);
    expect(parseBootstrapArgs(['--spec', 'a.json', '--spec', 'b.json']).wrong).toBe(true);
    expect(parseBootstrapArgs(['--spec', '--commit']).specPath).toBeUndefined();
    expect(parseBootstrapArgs([]).specPath).toBeUndefined();
  });

  const base = { company: { name: 'X' }, project: { name: 'P', short: 'P', siteCode: 'S' } };
  const consultant = (discipline: string) => ({ ...base, people: [{ name: 'A', email: 'a@test.local', companyRole: 'owner', projectRole: 'consultant', discipline }] });

  it('refuses an unknown time zone as a bad spec, before any database work', () => {
    expect(bootstrapSpecSchema.safeParse({ ...base, project: { ...base.project, timeZone: 'Mars/Olympus_Mons' }, people: consultant('Structure').people }).success).toBe(false);
    expect(bootstrapSpecSchema.safeParse({ ...base, project: { ...base.project, timeZone: 'Asia/Kolkata' }, people: consultant('Structure').people }).success).toBe(true);
  });

  it('bounds a discipline at 40 characters, as the app does', () => {
    expect(bootstrapSpecSchema.safeParse(consultant('x'.repeat(40))).success).toBe(true);
    expect(bootstrapSpecSchema.safeParse(consultant('x'.repeat(41))).success).toBe(false);
  });
});
