'use strict';

// Minimal dependency-free ZIP (ZIP32) reader/writer.
// Writer streams file data and uses data descriptors; reader parses the
// central directory and extracts entries by streaming.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform, Writable } = require('node:stream');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (3 << 8) | 20; // Unix, spec 2.0
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xfffe; // 0xffff is the ZIP64 sentinel
const CHUNK = 64 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// CRC-32

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc, buffer) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Small helpers

function dosDateTime(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { time: dosTime, date: dosDate };
}

function normalizeMode(mode, isDirectory) {
  if (mode === undefined || mode === null) return isDirectory ? 0o40755 : 0o644;
  if (!Number.isInteger(mode) || mode < 0 || mode > MAX_UINT32) {
    throw new TypeError('entry.mode must be a 32-bit unsigned integer');
  }
  return mode >>> 0;
}

function validateEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('zip entry name must be a non-empty string');
  }
  if (name.includes('\0')) throw new TypeError(`invalid zip entry name: ${JSON.stringify(name)}`);
  if (name.includes('\\')) throw new TypeError(`zip entry names must use forward slashes: ${JSON.stringify(name)}`);

  const isDirectory = name.endsWith('/');
  const body = isDirectory ? name.slice(0, -1) : name;
  if (body.length === 0) throw new TypeError('zip entry name must not be empty');
  if (body.startsWith('/')) throw new TypeError(`zip entry name must be relative: ${JSON.stringify(name)}`);
  if (/^[A-Za-z]:/.test(body)) throw new TypeError(`zip entry name must not contain a drive letter: ${JSON.stringify(name)}`);

  for (const segment of body.split('/')) {
    if (segment === '') throw new TypeError(`zip entry name has an empty segment: ${JSON.stringify(name)}`);
    if (segment === '.' || segment === '..') {
      throw new TypeError(`zip entry name must not contain "." or ".." segments: ${JSON.stringify(name)}`);
    }
  }
  return { isDirectory, nameBytes: Buffer.from(name, 'utf8') };
}

// `name` is a candidate path from an archive. Returns the resolved absolute
// target, or null when the name is unsafe.
function resolveSafeTarget(root, name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) return null;
  const unified = name.replace(/\\/g, '/');
  if (unified.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(unified)) return null;

  const segments = [];
  for (const segment of unified.split('/')) {
    if (segment === '') continue;
    if (segment === '.' || segment === '..') return null;
    segments.push(segment);
  }
  if (segments.length === 0) return null;

  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return null;
  }
  return target;
}

function decodeName(bytes, flags) {
  if (flags & FLAG_UTF8) return bytes.toString('utf8');
  const utf8 = bytes.toString('utf8');
  return Buffer.from(utf8, 'utf8').equals(bytes) ? utf8 : bytes.toString('latin1');
}

async function readExact(handle, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) throw new Error('unexpected end of file');
    read += bytesRead;
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Record builders

function buildLocalHeader({ nameBytes, flags, method, time, date }) {
  const buffer = Buffer.alloc(30 + nameBytes.length);
  buffer.writeUInt32LE(SIG_LOCAL, 0);
  buffer.writeUInt16LE(VERSION_NEEDED, 4);
  buffer.writeUInt16LE(flags, 6);
  buffer.writeUInt16LE(method, 8);
  buffer.writeUInt16LE(time, 10);
  buffer.writeUInt16LE(date, 12);
  // crc and sizes are zero: bit 3 means they are in the data descriptor
  buffer.writeUInt16LE(nameBytes.length, 26);
  buffer.writeUInt16LE(0, 28);
  nameBytes.copy(buffer, 30);
  return buffer;
}

function buildDataDescriptor(crc, compressedSize, uncompressedSize) {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(SIG_DESCRIPTOR, 0);
  buffer.writeUInt32LE(crc, 4);
  buffer.writeUInt32LE(compressedSize, 8);
  buffer.writeUInt32LE(uncompressedSize, 12);
  return buffer;
}

function buildCentralHeader(record) {
  const buffer = Buffer.alloc(46 + record.nameBytes.length);
  buffer.writeUInt32LE(SIG_CENTRAL, 0);
  buffer.writeUInt16LE(VERSION_MADE_BY, 4);
  buffer.writeUInt16LE(VERSION_NEEDED, 6);
  buffer.writeUInt16LE(record.flags, 8);
  buffer.writeUInt16LE(record.method, 10);
  buffer.writeUInt16LE(record.time, 12);
  buffer.writeUInt16LE(record.date, 14);
  buffer.writeUInt32LE(record.crc, 16);
  buffer.writeUInt32LE(record.compressedSize, 20);
  buffer.writeUInt32LE(record.uncompressedSize, 24);
  buffer.writeUInt16LE(record.nameBytes.length, 28);
  buffer.writeUInt16LE(0, 30); // extra length
  buffer.writeUInt16LE(0, 32); // comment length
  buffer.writeUInt16LE(0, 34); // disk number start
  buffer.writeUInt16LE(0, 36); // internal attributes
  buffer.writeUInt32LE(record.externalAttributes, 38);
  buffer.writeUInt32LE(record.localOffset, 42);
  record.nameBytes.copy(buffer, 46);
  return buffer;
}

function buildEndOfCentralDirectory(count, centralOffset, centralSize) {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt32LE(SIG_EOCD, 0);
  buffer.writeUInt16LE(0, 4); // disk number
  buffer.writeUInt16LE(0, 6); // central directory disk
  buffer.writeUInt16LE(count, 8);
  buffer.writeUInt16LE(count, 10);
  buffer.writeUInt32LE(centralSize, 12);
  buffer.writeUInt32LE(centralOffset, 16);
  buffer.writeUInt16LE(0, 20); // comment length
  return buffer;
}

// ---------------------------------------------------------------------------
// Streaming plumbing

class FdWriter {
  constructor(handle) {
    this.handle = handle;
    this.position = 0;
  }

  async write(buffer) {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await this.handle.write(buffer, offset, buffer.length - offset, this.position);
      if (bytesWritten <= 0) throw new Error('failed to write zip archive');
      offset += bytesWritten;
      this.position += bytesWritten;
    }
  }

  async truncate(position) {
    await this.handle.truncate(position);
    this.position = position;
  }
}

class CrcCounter extends Transform {
  constructor() {
    super({ highWaterMark: CHUNK });
    this.crc = 0;
    this.bytes = 0;
  }

  _transform(chunk, encoding, callback) {
    this.crc = crc32Update(this.crc, chunk);
    this.bytes += chunk.length;
    callback(null, chunk);
  }
}

class ByteSink extends Writable {
  constructor(writer) {
    super({ highWaterMark: CHUNK });
    this.writer = writer;
    this.bytes = 0;
  }

  _write(chunk, encoding, callback) {
    this.writer.write(chunk).then(() => {
      this.bytes += chunk.length;
      callback();
    }, callback);
  }
}

class CappedCollector extends Writable {
  constructor(maxBytes) {
    super({ highWaterMark: CHUNK });
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.bytes = 0;
  }

  _write(chunk, encoding, callback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new Error(`zip entry is larger than the ${this.maxBytes} byte limit`));
      return;
    }
    this.chunks.push(chunk);
    callback();
  }
}

function createSource({ buffer, filePath }) {
  if (buffer) return Readable.from([buffer]);
  return fs.createReadStream(filePath, { highWaterMark: CHUNK });
}

async function streamSource(source, counter, sink, compress, level) {
  const streams = [source, counter];
  if (compress) streams.push(zlib.createDeflateRaw({ level }));
  streams.push(sink);
  await pipeline(...streams);
}

// ---------------------------------------------------------------------------
// Writing

async function writeZip(destFile, entries, options = {}) {
  if (typeof destFile !== 'string' || destFile.length === 0) {
    throw new TypeError('destFile must be a non-empty string');
  }
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`classic ZIP supports at most ${MAX_ENTRIES} entries (no ZIP64)`);
  }
  const defaultCompress = options.compress !== false;
  const level = options.level === undefined ? 1 : options.level;

  const handle = await fsp.open(destFile, 'w');
  const writer = new FdWriter(handle);
  const centralBuffers = [];
  let files = 0;
  let bytes = 0;
  let compressedBytes = 0;
  let completed = false;

  try {
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') {
        throw new TypeError('each entry must be an object');
      }
      const { isDirectory, nameBytes } = validateEntryName(entry.name);
      const mode = normalizeMode(entry.mode, isDirectory);
      const externalAttributes = ((mode << 16) | (isDirectory ? 0x10 : 0)) >>> 0;

      let buffer = null;
      let filePath = null;
      let mtime = new Date();
      if (!isDirectory) {
        if (entry.data !== undefined && entry.data !== null) {
          if (Buffer.isBuffer(entry.data)) {
            buffer = entry.data;
          } else if (typeof entry.data === 'string') {
            buffer = Buffer.from(entry.data, 'utf8');
          } else {
            throw new TypeError('entry.data must be a Buffer or a string');
          }
        } else if (entry.path !== undefined && entry.path !== null) {
          if (typeof entry.path !== 'string' || entry.path.length === 0) {
            throw new TypeError('entry.path must be a non-empty string');
          }
          filePath = entry.path;
          const stat = await fsp.stat(filePath);
          if (!stat.isFile()) throw new Error(`entry.path is not a regular file: ${filePath}`);
          if (stat.size > MAX_UINT32) {
            throw new Error(`file is too large for classic ZIP (no ZIP64): ${filePath}`);
          }
          mtime = stat.mtime;
        } else {
          buffer = Buffer.alloc(0);
        }
      }

      const compress = !isDirectory && (entry.compress === undefined ? defaultCompress : Boolean(entry.compress));
      const { time, date } = dosDateTime(mtime);
      const flags = FLAG_DESCRIPTOR | FLAG_UTF8;
      let method = compress ? 8 : 0;
      const localOffset = writer.position;
      await writer.write(buildLocalHeader({ nameBytes, flags, method, time, date }));

      let crc = 0;
      let uncompressedSize = 0;
      let compressedSize = 0;
      if (!isDirectory) {
        const counter = new CrcCounter();
        const sink = new ByteSink(writer);
        await streamSource(createSource({ buffer, filePath }), counter, sink, compress, level);
        crc = counter.crc;
        uncompressedSize = counter.bytes;
        compressedSize = sink.bytes;

        // Deflate only pays off when it actually shrinks the data.
        if (compress && compressedSize >= uncompressedSize) {
          await writer.truncate(localOffset);
          method = 0;
          await writer.write(buildLocalHeader({ nameBytes, flags, method, time, date }));
          const rawCounter = new CrcCounter();
          const rawSink = new ByteSink(writer);
          await streamSource(createSource({ buffer, filePath }), rawCounter, rawSink, false, level);
          crc = rawCounter.crc;
          uncompressedSize = rawCounter.bytes;
          compressedSize = rawSink.bytes;
        }
        if (uncompressedSize > MAX_UINT32 || compressedSize > MAX_UINT32) {
          throw new Error(`entry is too large for classic ZIP (no ZIP64): ${entry.name}`);
        }
        files += 1;
        bytes += uncompressedSize;
        compressedBytes += compressedSize;
      }

      if (writer.position + 16 > MAX_UINT32) {
        throw new Error('zip archive exceeds 0xFFFFFFFF bytes (ZIP64 is not supported)');
      }
      await writer.write(buildDataDescriptor(crc, compressedSize, uncompressedSize));

      centralBuffers.push(buildCentralHeader({
        nameBytes,
        flags,
        method,
        time,
        date,
        crc,
        compressedSize,
        uncompressedSize,
        externalAttributes,
        localOffset,
      }));
    }

    const centralOffset = writer.position;
    for (const record of centralBuffers) await writer.write(record);
    const centralSize = writer.position - centralOffset;
    if (writer.position + 22 > MAX_UINT32) {
      throw new Error('zip archive exceeds 0xFFFFFFFF bytes (ZIP64 is not supported)');
    }
    await writer.write(buildEndOfCentralDirectory(centralBuffers.length, centralOffset, centralSize));
    completed = true;
  } finally {
    await handle.close();
    if (!completed) await fsp.unlink(destFile).catch(() => {});
  }

  return { entries: centralBuffers.length, files, bytes, compressedBytes };
}

// ---------------------------------------------------------------------------
// Central directory parsing

async function locateEndOfCentralDirectory(handle, fileSize) {
  if (fileSize < 22) throw new Error('not a zip archive: file is too small');
  const tailLength = Math.min(fileSize, 22 + 0xffff);
  const tail = await readExact(handle, fileSize - tailLength, tailLength);

  let found = -1;
  // Prefer a record whose comment ends exactly at EOF.
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      found = i;
      break;
    }
  }
  // Tolerate trailing bytes after the comment.
  if (found < 0) {
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
        found = i;
        break;
      }
    }
  }
  if (found < 0) throw new Error('not a zip archive: end of central directory record not found');

  const diskNumber = tail.readUInt16LE(found + 4);
  const centralDisk = tail.readUInt16LE(found + 6);
  if (diskNumber !== 0 || centralDisk !== 0) {
    throw new Error('multi-disk zip archives are not supported');
  }

  return {
    entriesDisk: tail.readUInt16LE(found + 8),
    entriesTotal: tail.readUInt16LE(found + 10),
    centralSize: tail.readUInt32LE(found + 12),
    centralOffset: tail.readUInt32LE(found + 16),
    commentLength: tail.readUInt16LE(found + 20),
  };
}

async function readCentralDirectory(file) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('file must be a non-empty string');
  }
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const eocd = await locateEndOfCentralDirectory(handle, size);

    if (eocd.entriesTotal === 0xffff || eocd.centralSize === MAX_UINT32 || eocd.centralOffset === MAX_UINT32) {
      throw new Error('ZIP64 archives are not supported');
    }
    if (eocd.centralOffset + eocd.centralSize > size) {
      throw new Error('corrupt zip archive: central directory is out of bounds');
    }

    const directory = eocd.centralSize === 0
      ? Buffer.alloc(0)
      : await readExact(handle, eocd.centralOffset, eocd.centralSize);

    const entries = [];
    let position = 0;
    while (position + 46 <= directory.length) {
      if (directory.readUInt32LE(position) !== SIG_CENTRAL) {
        if (directory.readUInt32LE(position) === 0x05054b50) break; // digital signature
        throw new Error('corrupt zip archive: bad central directory record');
      }
      const flags = directory.readUInt16LE(position + 8);
      const method = directory.readUInt16LE(position + 10);
      const crc = directory.readUInt32LE(position + 16);
      const compressedSize = directory.readUInt32LE(position + 20);
      const size_ = directory.readUInt32LE(position + 24);
      const nameLength = directory.readUInt16LE(position + 28);
      const extraLength = directory.readUInt16LE(position + 30);
      const commentLength = directory.readUInt16LE(position + 32);
      const externalAttributes = directory.readUInt32LE(position + 38);
      const localHeaderOffset = directory.readUInt32LE(position + 42);
      const nameStart = position + 46;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > directory.length) throw new Error('corrupt zip archive: entry name is out of bounds');

      if (compressedSize === MAX_UINT32 || size_ === MAX_UINT32 || localHeaderOffset === MAX_UINT32) {
        throw new Error('ZIP64 archives are not supported');
      }

      const name = decodeName(directory.subarray(nameStart, nameEnd), flags);
      entries.push({
        name,
        flags,
        method,
        crc,
        size: size_,
        compressedSize,
        externalAttributes,
        localHeaderOffset,
        isDirectory: name.endsWith('/') || (externalAttributes & 0x10) !== 0,
      });
      position = nameEnd + extraLength + commentLength;
    }
    return { entries };
  } finally {
    await handle.close();
  }
}

async function localDataStart(handle, entry) {
  const header = await readExact(handle, entry.localHeaderOffset, 30);
  if (header.readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error(`corrupt zip archive: bad local header for "${entry.name}"`);
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  return entry.localHeaderOffset + 30 + nameLength + extraLength;
}

function assertDecodable(entry) {
  if (entry.flags & FLAG_ENCRYPTED) throw new Error(`encrypted zip entries are not supported: "${entry.name}"`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`unsupported zip compression method ${entry.method} for "${entry.name}"`);
  }
}

async function openEntryStream(file, handle, entry) {
  const start = await localDataStart(handle, entry);
  if (entry.compressedSize === 0) return null;
  return fs.createReadStream(file, {
    start,
    end: start + entry.compressedSize - 1,
    highWaterMark: CHUNK,
  });
}

// ---------------------------------------------------------------------------
// Listing

async function listZip(file) {
  const { entries } = await readCentralDirectory(file);
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory,
    size: entry.size,
    compressedSize: entry.compressedSize,
    method: entry.method,
    crc: entry.crc,
  }));
}

// ---------------------------------------------------------------------------
// Extraction

async function lstatOrNull(target) {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function extractZip(file, destDir, options = {}) {
  if (typeof destDir !== 'string' || destDir.length === 0) {
    throw new TypeError('destDir must be a non-empty string');
  }
  const overwrite = options.overwrite !== false;
  const root = path.resolve(destDir);
  await fsp.mkdir(root, { recursive: true });

  const { entries } = await readCentralDirectory(file);
  const handle = await fsp.open(file, 'r');
  let files = 0;
  let bytes = 0;
  let skipped = 0;

  try {
    for (const entry of entries) {
      const target = resolveSafeTarget(root, entry.name);
      if (target === null) {
        skipped += 1;
        continue;
      }

      if (entry.isDirectory) {
        const existing = await lstatOrNull(target);
        if (existing && !existing.isDirectory()) {
          if (!overwrite) {
            skipped += 1;
            continue;
          }
          await fsp.unlink(target);
        }
        await fsp.mkdir(target, { recursive: true });
        continue;
      }

      assertDecodable(entry);
      const existing = await lstatOrNull(target);
      if (existing && !overwrite) {
        skipped += 1;
        continue;
      }
      if (existing && existing.isDirectory()) {
        skipped += 1;
        continue;
      }
      if (existing && existing.isSymbolicLink()) await fsp.unlink(target);

      await fsp.mkdir(path.dirname(target), { recursive: true });

      if (entry.size === 0 && entry.compressedSize === 0) {
        await fsp.writeFile(target, Buffer.alloc(0));
        files += 1;
        continue;
      }

      const source = await openEntryStream(file, handle, entry);
      if (source === null) {
        await fsp.writeFile(target, Buffer.alloc(0));
        files += 1;
        continue;
      }
      const counter = new CrcCounter();
      const sink = fs.createWriteStream(target, { flags: 'w' });
      const streams = [source];
      if (entry.method === 8) streams.push(zlib.createInflateRaw());
      streams.push(counter, sink);
      await pipeline(...streams);
      if (entry.crc && counter.crc !== entry.crc) {
        throw new Error(`CRC mismatch while extracting "${entry.name}" (archive is corrupt)`);
      }
      bytes += counter.bytes;
      files += 1;

      if (process.platform !== 'win32' && entry.externalAttributes) {
        const mode = (entry.externalAttributes >>> 16) & 0o777;
        if (mode) await fsp.chmod(target, mode).catch(() => {});
      }
    }
  } finally {
    await handle.close();
  }

  return { files, bytes, skipped };
}

// ---------------------------------------------------------------------------
// Single entry read

async function readZipEntry(file, name, options = {}) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('name must be a non-empty string');
  }
  const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_ENTRY_BYTES : options.maxBytes;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new TypeError('options.maxBytes must be a non-negative finite number');
  }

  const { entries } = await readCentralDirectory(file);
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) return null;
  if (entry.isDirectory) return Buffer.alloc(0);
  assertDecodable(entry);
  if (entry.size > maxBytes) {
    throw new Error(`zip entry "${name}" is too large (${entry.size} bytes, limit ${maxBytes})`);
  }

  const handle = await fsp.open(file, 'r');
  try {
    const source = await openEntryStream(file, handle, entry);
    if (source === null) return Buffer.alloc(0);
    const collector = new CappedCollector(maxBytes);
    const streams = [source];
    if (entry.method === 8) streams.push(zlib.createInflateRaw());
    streams.push(collector);
    await pipeline(...streams);
    return Buffer.concat(collector.chunks, collector.bytes);
  } finally {
    await handle.close();
  }
}

module.exports = { writeZip, listZip, extractZip, readZipEntry };
