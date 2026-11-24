'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { writeZip, listZip, extractZip, readZipEntry } = require('../lib/zip');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_DESCRIPTOR = 0x08074b50;

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dshm-zip-${label}-`));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

function sameFile(actual, expected) {
  assert.deepEqual(fs.readFileSync(actual), expected);
}

test('round trip: nested dirs, unicode names, empty/random/compressible files', async (t) => {
  const root = tempDir('roundtrip');
  t.after(() => cleanup(root));

  const src = path.join(root, 'src');
  const dest = path.join(root, 'out');
  const archive = path.join(root, 'roundtrip.zip');

  const unicodeName = '中文-😀.txt';
  const unicodeData = Buffer.from('unicode: 你好，世界 😀\n'.repeat(20), 'utf8');
  const randomData = crypto.randomBytes(1024 * 1024);
  const textData = Buffer.from('The quick brown fox jumps over the lazy dog.\n'.repeat(4000), 'utf8');

  const unicodePath = writeFile(path.join(src, 'nested', 'dir', unicodeName), unicodeData);
  const randomPath = writeFile(path.join(src, 'random.bin'), randomData);
  const textPath = writeFile(path.join(src, 'text.txt'), textData);

  const stats = await writeZip(archive, [
    { name: 'nested/' },
    { name: 'nested/dir/' },
    { name: `nested/dir/${unicodeName}`, path: unicodePath },
    { name: 'nested/empty.bin', data: Buffer.alloc(0) },
    { name: 'random.bin', path: randomPath },
    { name: 'text.txt', path: textPath },
  ]);

  assert.equal(stats.entries, 6);
  assert.equal(stats.files, 4);
  assert.equal(stats.bytes, unicodeData.length + randomData.length + textData.length);
  assert.ok(stats.compressedBytes < stats.bytes, 'compressible data should shrink the archive');

  const listed = await listZip(archive);
  assert.deepEqual(
    listed.map((entry) => entry.name),
    ['nested/', 'nested/dir/', `nested/dir/${unicodeName}`, 'nested/empty.bin', 'random.bin', 'text.txt'],
  );
  const byName = new Map(listed.map((entry) => [entry.name, entry]));
  assert.equal(byName.get('nested/').isDirectory, true);
  assert.equal(byName.get('nested/').size, 0);
  assert.equal(byName.get('nested/dir/').isDirectory, true);
  assert.equal(byName.get('nested/empty.bin').isDirectory, false);
  assert.equal(byName.get('nested/empty.bin').size, 0);
  assert.equal(byName.get('random.bin').method, 0, 'incompressible data must fall back to store');
  assert.equal(byName.get('text.txt').method, 8);
  assert.ok(byName.get('text.txt').compressedSize < byName.get('text.txt').size);

  const extracted = await extractZip(archive, dest);
  assert.equal(extracted.files, 4);
  assert.equal(extracted.bytes, stats.bytes);
  assert.equal(extracted.skipped, 0);

  sameFile(path.join(dest, 'nested', 'dir', unicodeName), unicodeData);
  sameFile(path.join(dest, 'nested', 'empty.bin'), Buffer.alloc(0));
  sameFile(path.join(dest, 'random.bin'), randomData);
  sameFile(path.join(dest, 'text.txt'), textData);
  assert.equal(fs.statSync(path.join(dest, 'nested')).isDirectory(), true);
  assert.equal(fs.statSync(path.join(dest, 'nested', 'dir')).isDirectory(), true);

  // Sanity check the streaming layout: bit 3 set, data descriptor appended.
  const raw = fs.readFileSync(archive);
  const textNameOffset = raw.indexOf(Buffer.from('text.txt'));
  const textLocalOffset = textNameOffset - 30;
  assert.equal(raw.readUInt32LE(textLocalOffset), SIG_LOCAL);
  assert.equal(raw.readUInt16LE(textLocalOffset + 6) & 0x0008, 0x0008);
  const localNameLength = raw.readUInt16LE(textLocalOffset + 26);
  const localExtraLength = raw.readUInt16LE(textLocalOffset + 28);
  assert.equal(textLocalOffset + 30, textNameOffset);
  const fsEntry = byName.get('text.txt');
  const descriptorOffset = textLocalOffset + 30 + localNameLength + localExtraLength + fsEntry.compressedSize;
  assert.equal(raw.readUInt32LE(descriptorOffset), SIG_DESCRIPTOR);
  assert.equal(raw.readUInt32LE(descriptorOffset + 4), fsEntry.crc);
  assert.equal(raw.readUInt32LE(descriptorOffset + 8), fsEntry.compressedSize);
  assert.equal(raw.readUInt32LE(descriptorOffset + 12), fsEntry.size);

  const centralOffset = raw.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralOffset > 0);
  assert.equal(raw.readUInt32LE(centralOffset), SIG_CENTRAL);
  assert.equal(raw.readUInt16LE(centralOffset + 4), (3 << 8) | 20);
});

test('stored-mode archive extracts correctly', async (t) => {
  const root = tempDir('stored');
  t.after(() => cleanup(root));
  const archive = path.join(root, 'stored.zip');
  const dest = path.join(root, 'out');
  const text = 'stored payload '.repeat(500);
  const binary = crypto.randomBytes(64 * 1024);

  const stats = await writeZip(archive, [
    { name: 'docs/' },
    { name: 'docs/readme.txt', data: text },
    { name: 'blob.bin', data: binary },
  ], { compress: false });

  assert.equal(stats.entries, 3);
  assert.equal(stats.files, 2);
  assert.equal(stats.bytes, Buffer.byteLength(text) + binary.length);
  assert.equal(stats.compressedBytes, stats.bytes);

  const listed = await listZip(archive);
  assert.ok(listed.every((entry) => entry.method === 0));

  const result = await extractZip(archive, dest);
  assert.equal(result.files, 2);
  sameFile(path.join(dest, 'docs', 'readme.txt'), Buffer.from(text));
  sameFile(path.join(dest, 'blob.bin'), binary);
});

test('listZip reports names, sizes, methods and directories, and handles EOCD comments', async (t) => {
  const root = tempDir('list');
  t.after(() => cleanup(root));
  const archive = path.join(root, 'list.zip');
  const payload = Buffer.from('x'.repeat(1000));

  await writeZip(archive, [
    { name: 'dir/' },
    { name: 'dir/one.txt', data: 'one' },
    { name: 'dir/two.bin', data: payload },
    { name: 'stored.txt', data: 'plain', compress: false },
  ]);

  const entries = await listZip(archive);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((entry) => entry.name), ['dir/', 'dir/one.txt', 'dir/two.bin', 'stored.txt']);

  const [dir, one, two, stored] = entries;
  assert.equal(dir.isDirectory, true);
  assert.equal(dir.size, 0);
  assert.equal(dir.compressedSize, 0);
  assert.equal(one.isDirectory, false);
  assert.equal(one.size, 3);
  assert.equal(two.size, 1000);
  assert.equal(stored.method, 0);
  assert.equal(two.method, 8);
  assert.ok(Number.isInteger(two.crc) && two.crc >= 0);

  // Append a comment and update the EOCD comment-length field.
  const raw = fs.readFileSync(archive);
  const eocdOffset = raw.length - 22;
  assert.equal(raw.readUInt32LE(eocdOffset), 0x06054b50);
  const comment = Buffer.from('archive comment 测试', 'utf8');
  const patched = Buffer.concat([raw, comment]);
  patched.writeUInt16LE(comment.length, eocdOffset + 20);
  fs.writeFileSync(archive, patched);

  const commented = await listZip(archive);
  assert.deepEqual(commented.map((entry) => entry.name), entries.map((entry) => entry.name));
});

test('readZipEntry returns manifest data, null for missing entries, and enforces maxBytes', async (t) => {
  const root = tempDir('readentry');
  t.after(() => cleanup(root));
  const archive = path.join(root, 'entries.zip');
  const manifest = { name: 'demo', version: 3, files: ['a.txt', 'b/c.txt'], note: '你好 😀' };

  await writeZip(archive, [
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: 'plain.txt', data: 'plain text', compress: false },
    { name: 'big.bin', data: crypto.randomBytes(1024 * 1024) },
  ]);

  const manifestBuffer = await readZipEntry(archive, 'manifest.json');
  assert.ok(Buffer.isBuffer(manifestBuffer));
  assert.deepEqual(JSON.parse(manifestBuffer.toString('utf8')), manifest);
  assert.equal(manifestBuffer.toString('utf8'), JSON.stringify(manifest));

  assert.deepEqual(await readZipEntry(archive, 'plain.txt'), Buffer.from('plain text'));
  assert.equal(await readZipEntry(archive, 'missing.json'), null);
  await assert.rejects(() => readZipEntry(archive, 'big.bin', { maxBytes: 1024 }), /too large/);
  await assert.rejects(
    () => readZipEntry(archive, 'manifest.json', { maxBytes: 2 }),
    /too large/,
  );
});

test('writeZip rejects unsafe names', async (t) => {
  const root = tempDir('unsafe');
  t.after(() => cleanup(root));
  const archive = path.join(root, 'unsafe.zip');

  const unsafeNames = ['..', '.', '../x.txt', '/abs.txt', 'C:/x.txt', 'a/../b.txt', '..\\x.txt', 'a//b.txt', '', 'bad\0name'];
  for (const name of unsafeNames) {
    await assert.rejects(
      () => writeZip(archive, [{ name, data: 'x' }]),
      TypeError,
      `expected TypeError for name ${JSON.stringify(name)}`,
    );
  }
  assert.equal(fs.existsSync(archive), false, 'failed writes should not leave an archive behind');
});

test('extractZip refuses zip-slip entries patched into the archive', async (t) => {
  const root = tempDir('slip');
  t.after(() => cleanup(root));
  const archive = path.join(root, 'slip.zip');
  const dest = path.join(root, 'sandbox');

  await writeZip(archive, [{ name: 'safe.txt', data: 'owned' }]);

  // 'safe.txt' and '../x.txt' are both 8 bytes, so patches keep offsets valid.
  const raw = fs.readFileSync(archive);
  const from = Buffer.from('safe.txt');
  const to = Buffer.from('../x.txt');
  assert.equal(from.length, to.length);
  let patches = 0;
  let index = raw.indexOf(from);
  while (index !== -1) {
    to.copy(raw, index);
    patches += 1;
    index = raw.indexOf(from, index + from.length);
  }
  assert.equal(patches, 2, 'name appears in both the local header and central directory');
  fs.writeFileSync(archive, raw);

  assert.equal((await listZip(archive))[0].name, '../x.txt');

  const result = await extractZip(archive, dest);
  assert.equal(result.files, 0);
  assert.equal(result.bytes, 0);
  assert.equal(result.skipped, 1);
  assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
  assert.equal(fs.existsSync(path.join(dest, 'x.txt')), false);
  assert.deepEqual(fs.readdirSync(root).sort(), ['sandbox', 'slip.zip']);
});

test('large archive (>10 MB, many files) survives streaming round trip', async (t) => {
  const root = tempDir('large');
  t.after(() => cleanup(root));
  const src = path.join(root, 'src');
  const dest = path.join(root, 'out');
  const archive = path.join(root, 'large.zip');

  const fileCount = 34;
  const fileSize = 320 * 1024; // 10.6 MiB of incompressible data
  const expected = new Map();
  const entries = [];
  for (let i = 0; i < fileCount; i += 1) {
    const name = `chunk-${String(i).padStart(2, '0')}.bin`;
    const data = crypto.randomBytes(fileSize);
    const filePath = writeFile(path.join(src, name), data);
    expected.set(name, data);
    entries.push({ name, path: filePath });
  }

  const stats = await writeZip(archive, entries);
  assert.equal(stats.entries, fileCount);
  assert.equal(stats.files, fileCount);
  assert.equal(stats.bytes, fileCount * fileSize);
  assert.ok(fs.statSync(archive).size > 10 * 1024 * 1024);

  const listed = await listZip(archive);
  assert.equal(listed.length, fileCount);
  assert.ok(listed.every((entry) => entry.method === 0));

  const result = await extractZip(archive, dest);
  assert.equal(result.files, fileCount);
  assert.equal(result.bytes, fileCount * fileSize);
  assert.equal(result.skipped, 0);

  for (const [name, data] of expected) {
    assert.deepEqual(fs.readFileSync(path.join(dest, name)), data, `mismatch for ${name}`);
  }
});
