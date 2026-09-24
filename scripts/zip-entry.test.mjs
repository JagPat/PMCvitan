import assert from 'node:assert/strict';
import test from 'node:test';

import { crc32, readZipEntry } from './zip-entry.mjs';
import { buildZip } from './zip-test-fixture.mjs';

const NAME = 'claude-shadow-evidence.json';
const TEXT = JSON.stringify({ findings: [{ description: 'x'.repeat(500) }] });

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('reads one named entry, deflated or stored, with or without a data descriptor', () => {
  for (const shape of [{}, { method: 0 }, { descriptor: false }, { method: 0, descriptor: false }]) {
    const zip = buildZip([{ name: 'other.txt', data: 'ignore me' }, { name: NAME, data: TEXT, ...shape }]);
    assert.equal(readZipEntry(zip, NAME)?.toString('utf8'), TEXT, JSON.stringify(shape));
  }
  // A trailing archive comment does not hide the end-of-central-directory record.
  const archive = buildZip([{ name: NAME, data: TEXT }]);
  archive.writeUInt16LE(7, archive.length - 2);
  const commented = Buffer.concat([archive, Buffer.from('comment')]);
  assert.equal(readZipEntry(commented, NAME)?.toString('utf8'), TEXT);
});

test('fails closed: missing, duplicated, corrupt, encrypted, oversized, unknown-method or truncated', () => {
  const good = buildZip([{ name: NAME, data: TEXT }]);
  const cases = [
    ['no such entry', buildZip([{ name: 'other.txt', data: TEXT }])],
    ['two entries of that name', buildZip([{ name: NAME, data: TEXT }, { name: NAME, data: TEXT }])],
    ['CRC mismatch', buildZip([{ name: NAME, data: TEXT, crc: 1 }])],
    ['size mismatch', buildZip([{ name: NAME, data: TEXT, size: TEXT.length + 1 }])],
    ['encrypted', buildZip([{ name: NAME, data: TEXT, flags: 0x1 }])],
    ['unknown method', buildZip([{ name: NAME, data: TEXT, method: 12 }])],
    ['truncated', good.subarray(0, good.length - 30)],
    ['not a zip', Buffer.from('plain text, no archive at all')],
    ['empty', Buffer.alloc(0)],
  ];
  for (const [label, zip] of cases) assert.equal(readZipEntry(zip, NAME), null, label);
  assert.equal(readZipEntry(good, NAME, { maxBytes: TEXT.length - 1 }), null, 'over maxBytes');
  assert.equal(readZipEntry(buildZip([{ name: NAME, data: TEXT, method: 0 }]), NAME, { maxBytes: TEXT.length - 1 }), null, 'stored, over maxBytes');
  assert.equal(readZipEntry(undefined, NAME), null, 'no bytes');
});
