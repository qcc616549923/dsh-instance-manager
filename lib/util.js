'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJsonAtomic(file, value, { mode = 0o600 } = {}) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function writeTextAtomic(file, text, { mode = 0o600 } = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

function randomId(length = 3) {
  return crypto.randomBytes(length).toString('hex');
}

function slugify(text, fallback = 'instance') {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .toLowerCase();
  return slug || fallback;
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function tailLines(text, count) {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

/** Read at most `maxBytes` from the end of a file and return the last `count` lines. */
function readTail(file, count = 200, maxBytes = 512 * 1024) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return '';
  }
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  if (length <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return tailLines(buffer.toString('utf8'), count);
  } finally {
    fs.closeSync(fd);
  }
}

function formatTimestamp(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds()),
  ].join('');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when `child` is `parent` itself or a path below it (case-insensitive on Windows). */
function pathInside(child, parent) {
  if (!child || !parent) return false;
  let from = path.resolve(parent);
  let to = path.resolve(child);
  if (process.platform === 'win32') {
    from = from.toLowerCase();
    to = to.toLowerCase();
  }
  const relative = path.relative(from, to);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(left, right) {
  if (!left || !right) return false;
  let a = path.resolve(left);
  let b = path.resolve(right);
  if (process.platform === 'win32') {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a === b;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

function directorySize(dir, limitNodes = 200_000) {
  let total = 0;
  let nodes = 0;
  const stack = [dir];
  while (stack.length && nodes < limitNodes) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      nodes += 1;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(target).size;
        } catch {
          // Ignore files that vanish mid-scan.
        }
      }
    }
  }
  return { bytes: total, nodes };
}

/**
 * Recursively copy a directory. Files are copied rather than hard-linked so the
 * instance stays fully independent and does not inherit protected ACLs from the
 * Desktop profile (some plugins deny deletion on their runtime files).
 */
function copyTree(source, destination, { overwrite = false } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    let linkTarget;
    try {
      linkTarget = fs.readlinkSync(source);
    } catch {
      return;
    }
    if (!overwrite && fs.existsSync(destination)) return;
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(linkTarget, destination, 'junction');
    } catch {
      try {
        fs.copyFileSync(source, destination);
      } catch {
        // Give up on this entry; the profile normally still boots.
      }
    }
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyTree(path.join(source, entry), path.join(destination, entry), { overwrite });
    }
    return;
  }
  if (!stat.isFile()) return;
  if (!overwrite && fs.existsSync(destination)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.copyFileSync(source, destination);
    if ((stat.mode & 0o200) === 0) {
      try {
        fs.chmodSync(destination, 0o666);
      } catch {
        // Read-only copies are still deletable through removeTree's fallback.
      }
    }
  } catch {
    // Best effort: one unreadable file should not abort an instance creation.
  }
}

/** Remove deny-delete ACEs that some plugin runtime folders carry (Windows only). */
function clearDenyAcls(target) {
  if (process.platform !== 'win32') return;
  spawnSync('icacls', [target, '/remove:d', '*S-1-1-0', '/T', '/C', '/Q'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

/**
 * Remove a directory tree, including read-only files or protected ACLs left
 * behind by copied package payloads. Throws when the tree cannot be removed.
 */
function removeTree(target) {
  const makeWritable = (entry) => {
    let stat;
    try {
      stat = fs.lstatSync(entry);
    } catch {
      return;
    }
    try {
      fs.chmodSync(entry, stat.isDirectory() ? 0o777 : 0o666);
    } catch {
      // Ignore permission changes that the filesystem refuses.
    }
    if (!stat.isDirectory()) return;
    let children = [];
    try {
      children = fs.readdirSync(entry);
    } catch {
      return;
    }
    for (const child of children) makeWritable(path.join(entry, child));
  };
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    return;
  } catch {
    // Fall through and clear protected ACLs before retrying.
  }
  clearDenyAcls(target);
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    return;
  } catch {
    // Fall through and clear read-only attributes before the last attempt.
  }
  makeWritable(target);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

/** True when the path exists and is a symlink or junction rather than a real directory. */
function isDirLink(target) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink()) return false;
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

function readDirLinkTarget(target) {
  try {
    return fs.readlinkSync(target);
  } catch {
    return '';
  }
}

function moveDirectoryContents(source, destination) {
  if (!isDirectory(source)) return;
  ensureDir(destination);
  for (const entry of fs.readdirSync(source)) {
    const from = path.join(source, entry);
    const to = path.join(destination, entry);
    if (fs.existsSync(to)) {
      throw new Error(`目标目录已存在同名项，无法迁移：${to}`);
    }
    try {
      fs.renameSync(from, to);
    } catch {
      copyTree(from, to);
      fs.rmSync(from, { recursive: true, force: true });
    }
  }
}

function createDirLink(linkPath, targetPath) {
  ensureDir(path.dirname(linkPath));
  ensureDir(targetPath);
  if (process.platform === 'win32') {
    try {
      fs.symlinkSync(path.resolve(targetPath), linkPath, 'junction');
      return;
    } catch (error) {
      const result = spawnSync('cmd.exe', ['/d', '/s', '/c', 'mklink', '/J', linkPath, path.resolve(targetPath)], {
        windowsHide: true,
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        throw new Error(`无法创建目录联接：${(result.stderr || result.stdout || error.message).trim()}`);
      }
      return;
    }
  }
  fs.symlinkSync(path.resolve(targetPath), linkPath, 'dir');
}

/**
 * Point `linkPath` at `targetPath` as a directory link. Existing links are
 * replaced when they point elsewhere; an existing real directory is migrated
 * into the target first so no data is lost.
 */
function ensureDirLink(linkPath, targetPath) {
  const link = path.resolve(linkPath);
  const target = path.resolve(targetPath);
  if (samePath(link, target)) {
    ensureDir(target);
    return { changed: false };
  }
  ensureDir(target);
  if (isDirLink(link)) {
    const current = readDirLinkTarget(link);
    if (current && samePath(path.resolve(path.dirname(link), current), target)) {
      return { changed: false };
    }
    fs.rmSync(link, { recursive: true, force: true });
    createDirLink(link, target);
    return { changed: true, reason: '链接目标已更新' };
  }
  if (isDirectory(link)) {
    moveDirectoryContents(link, target);
    try {
      fs.rmdirSync(link);
    } catch {
      fs.rmSync(link, { recursive: true, force: true });
    }
  } else if (fs.existsSync(link)) {
    fs.rmSync(link, { force: true });
  }
  createDirLink(link, target);
  return { changed: true, reason: '已创建目录联接' };
}

module.exports = {
  ensureDir,
  readJson,
  readText,
  writeJsonAtomic,
  writeTextAtomic,
  randomId,
  slugify,
  isDirectory,
  isFile,
  readTail,
  tailLines,
  formatTimestamp,
  sleep,
  pathInside,
  samePath,
  formatBytes,
  directorySize,
  copyTree,
  removeTree,
  isDirLink,
  readDirLinkTarget,
  moveDirectoryContents,
  createDirLink,
  ensureDirLink,
};
