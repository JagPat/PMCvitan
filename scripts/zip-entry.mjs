import { inflateRawSync } from 'node:zlib';

/**
 * Read ONE named file out of a ZIP archive held in memory (a GitHub Actions artifact download), fail closed.
 *
 * Only what an artifact archive needs: the end-of-central-directory record, the central directory, and one
 * entry stored (method 0) or deflated (method 8). The central directory is authoritative for sizes (an
 * artifact zip streams with data descriptors, so the local header's sizes may be zero). The entry's CRC-32
 * and uncompressed size are checked. Anything else — no or several entries of that name, encryption, ZIP64,
 * an unknown method, a truncated or inconsistent archive, a size over `maxBytes` — returns `null`, never a
 * partial or unverified file.
 */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

let crcTable;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function readZipEntry(archive, name, { maxBytes = 1024 * 1024 } = {}) {
  const buffer = Buffer.isBuffer(archive) ? archive : Buffer.from(archive ?? []);
  if (buffer.length < EOCD_MIN) return null;
  // The end-of-central-directory record: within the last 22 + 65535 bytes.
  let eocd = -1;
  for (let at = buffer.length - EOCD_MIN; at >= Math.max(0, buffer.length - EOCD_MIN - MAX_COMMENT); at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return null;
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  // ZIP64 markers, or a directory that does not fit before the record, are not supported.
  if (entryCount === 0xffff || directoryOffset === 0xffffffff || directoryOffset + directorySize > eocd) return null;

  const matches = [];
  let at = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (at + 46 > eocd || buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) return null;
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const entryName = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    if (entryName === name) matches.push({ flags, method, crc, compressedSize, size, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (matches.length !== 1) return null;
  const [entry] = matches;
  if ((entry.flags & 0x1) !== 0 || entry.size > maxBytes || entry.compressedSize === 0xffffffff
    || entry.size === 0xffffffff) {
    return null;
  }
  const local = entry.localOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) return null;
  const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > directoryOffset) return null;
  const data = buffer.subarray(dataStart, dataEnd);
  let content;
  try {
    if (entry.method === 0) content = Buffer.from(data);
    else if (entry.method === 8) content = inflateRawSync(data, { maxOutputLength: maxBytes });
    else return null;
  } catch {
    return null;
  }
  if (content.length !== entry.size || crc32(content) !== entry.crc) return null;
  return content;
}
