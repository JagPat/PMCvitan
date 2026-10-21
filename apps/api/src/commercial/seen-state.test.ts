import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { assertSeen, seenPinPayload, seenState } from './seen-state';
import { rethrowDuplicateGrant } from './commercial-certification.service';

// #482 seen-state pins: the header parse, and the grant-duplicate mapping. The refusals under the
// lock are proved against PostgreSQL in test/integration/commercial-seen-state-pins.test.ts.
describe('seenState — the X-Vitan-Seen-State header', () => {
  it('is undefined when the header is absent (the unpinned send)', () => {
    expect(seenState(undefined, 'count')).toBeUndefined();
    expect(seenState(undefined, 'id')).toBeUndefined();
  });

  it('parses a count and an id', () => {
    expect(seenState('0', 'count')).toBe(0);
    expect(seenState('17', 'count')).toBe(17);
    expect(seenState(' 3 ', 'count')).toBe(3);
    expect(seenState('cmvh6443y00yw7dfenlg60ddu', 'id')).toBe('cmvh6443y00yw7dfenlg60ddu');
  });

  it.each([
    ['negative', '-1'],
    ['non-integer', '1.5'],
    ['leading zero', '01'],
    ['exponent', '1e3'],
    ['over-long', '12345678901234567'],
    ['empty', ''],
    ['blank', '   '],
    ['word', 'abc'],
  ])('refuses a %s count with 400', (_label, raw) => {
    expect(() => seenState(raw, 'count')).toThrow(BadRequestException);
  });

  it.each([
    ['empty', ''],
    ['count three', '3'],
    ['count zero', '0'],
    ['over-long', `c${'a'.repeat(32)}`],
    ['too short', `c${'a'.repeat(19)}`],
    ['no leading c', 'xmvh6443y00yw7dfenlg60ddu'],
    ['upper case', 'cMVH6443Y00YW7DFENLG60DDU'],
    ['punctuation', 'cmvh6443y00yw7dfenlg60d_u'],
    ['space inside', 'cmvh6443y00yw 7dfenlg60ddu'],
  ])('refuses a %s id with 400', (_label, raw) => {
    expect(() => seenState(raw, 'id')).toThrow(new BadRequestException("This entry's screen state could not be read. Reload and try again."));
  });

  it('accepts the shortest and longest cuid and the largest 16-digit count', () => {
    expect(seenState(`c${'a'.repeat(20)}`, 'id')).toBe(`c${'a'.repeat(20)}`);
    expect(seenState(`c${'a'.repeat(31)}`, 'id')).toBe(`c${'a'.repeat(31)}`);
    expect(seenState('1234567890123456', 'count')).toBe(1234567890123456);
  });
});

describe('assertSeen and seenPinPayload', () => {
  it('refuses only a pinned value that differs', () => {
    expect(() => assertSeen(undefined, 4, 'moved')).not.toThrow();
    expect(() => assertSeen(4, 4, 'moved')).not.toThrow();
    expect(() => assertSeen(3, 4, 'moved')).toThrow(new ConflictException('moved'));
    expect(() => assertSeen('a', 'b', 'moved')).toThrow(ConflictException);
  });

  it('records present or absent', () => {
    expect(seenPinPayload(undefined)).toEqual({ seenPin: 'absent' });
    expect(seenPinPayload(0)).toEqual({ seenPin: 'present' });
    expect(seenPinPayload('x')).toEqual({ seenPin: 'present' });
  });
});

describe('rethrowDuplicateGrant', () => {
  const p2002 = (target: unknown) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target } });

  it('maps the live-scope index to a plain 409', () => {
    expect(() => rethrowDuplicateGrant(p2002('SodGrant_live_scope_key')))
      .toThrow(new ConflictException('An exception for this person on this claim already stands. Reload to see it.'));
    const columns = ['reviewedLifecycleVersion', 'projectId', 'billId', 'versionId', 'rule', 'actorId', 'approverId', 'reviewedStatus'];
    expect(() => rethrowDuplicateGrant(p2002(columns))).toThrow(ConflictException);
  });

  it('rethrows a P2002 on another target unchanged', () => {
    const other = p2002('CommandExecution_projectId_commandType_idempotencyKey_key');
    expect(() => rethrowDuplicateGrant(other)).toThrow(other);
    const fewer = p2002(['projectId', 'billId']);
    expect(() => rethrowDuplicateGrant(fewer)).toThrow(fewer);
  });

  it('rethrows any other error unchanged', () => {
    const boom = new Error('boom');
    expect(() => rethrowDuplicateGrant(boom)).toThrow(boom);
  });
});
