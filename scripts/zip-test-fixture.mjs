import { deflateRawSync } from 'node:zlib';

import { crc32 } from './zip-entry.mjs';

// Shared test fixture (not a test file): builds a ZIP archive in memory, the way an Actions artifact
// download is shaped (deflated entries streamed with data descriptors), with knobs to corrupt it.
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const crc = entry.crc ?? crc32(data);
    const descriptor = entry.descriptor ?? true;
    const flags = (descriptor ? 0x8 : 0) | (entry.flags ?? 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const parts = [local, name, compressed];
    if (descriptor) {
      const trailer = Buffer.alloc(16);
      trailer.writeUInt32LE(0x08074b50, 0);
      trailer.writeUInt32LE(crc, 4);
      trailer.writeUInt32LE(compressed.length, 8);
      trailer.writeUInt32LE(data.length, 12);
      parts.push(trailer);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.size ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    const local0 = Buffer.concat(parts);
    locals.push(local0);
    offset += local0.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
