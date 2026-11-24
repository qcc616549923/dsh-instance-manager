'use strict';

/**
 * Import/export of the manager configuration and of whole instances.
 *
 * - The manager configuration is a small JSON document (settings + instance
 *   records). It intentionally contains no secrets: the manager never stores
 *   access tokens or API-key values.
 * - An instance archive is a ZIP with `dshm-instance.json` (manifest) plus the
 *   instance's DSH home, profile, sessions, logs and work directory payloads.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeZip, extractZip, readZipEntry } = require('./zip');
const { repairProfileModules } = require('./desktop');
const { resolveLayout, validateLayout, ensureLayout } = require('./layout');
const { commandForInstallDir, resolveInstallDir } = require('./dsh');
const {
  ensureDir,
  isDirectory,
  isFile,
  pathInside,
  randomId,
  removeTree,
  samePath,
} = require('./util');

const MANAGER_KIND = 'dshm-manager-config';
const INSTANCE_KIND = 'dshm-instance-archive';
const FORMAT_VERSION = 1;
const MANIFEST_NAME = 'dshm-instance.json';
const MAX_NAME = 40;

/* ------------------------------------------------------------------ */
/* Manager configuration                                               */
/* ------------------------------------------------------------------ */

function managerExportFileName() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `dshm-manager-${stamp}.json`;
}

/** Build the JSON document downloaded from the manager. */
function buildManagerExport(store, { managerVersion = '' } = {}) {
  return {
    kind: MANAGER_KIND,
    version: FORMAT_VERSION,
    managerVersion,
    exportedAt: new Date().toISOString(),
    hostname: os.hostname(),
    dataDir: store.dataDir,
    settings: { ...store.settings },
    instances: store.list(),
  };
}

/** Parse and validate an exported manager document (accepts text or object). */
function parseManagerExport(text) {
  let value = text;
  if (typeof text === 'string') {
    try {
      value = JSON.parse(text);
    } catch {
      throw badRequest('文件不是合法的 JSON');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('不是管理器配置导出文件');
  }
  if (value.kind && value.kind !== MANAGER_KIND) {
    throw badRequest('不是管理器配置导出文件（kind 不匹配）');
  }
  if (Number(value.version) > FORMAT_VERSION) {
    throw badRequest(`配置版本 ${value.version} 高于当前管理器支持的版本 ${FORMAT_VERSION}`);
  }
  if (!Array.isArray(value.instances)) {
    throw badRequest('配置文件缺少实例列表');
  }
  return value;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function cleanName(value, fallback = '实例') {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().replace(/\s+/g, ' ') : '';
  return (text || fallback).slice(0, MAX_NAME);
}

/** Instance ids become directory names, so only a conservative charset is allowed. */
function safeId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) ? id : '';
}

function ownInherit(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    plugins: Boolean(source.plugins),
    credentials: Boolean(source.credentials),
    config: Boolean(source.config),
  };
}

/** Only apply settings that make sense on this machine; return the applied patch. */
function settingsPatch(store, incoming, warnings) {
  const source = incoming && typeof incoming === 'object' ? incoming : {};
  const patch = {};
  if (source.openBrowser !== undefined) patch.openBrowser = Boolean(source.openBrowser);

  if (typeof source.desktopHome === 'string' && source.desktopHome.trim()) {
    const dir = source.desktopHome.trim();
    if (isDirectory(dir)) patch.desktopHome = dir;
    else warnings.push(`桌面配置目录不存在，已忽略：${dir}`);
  } else if (source.desktopHome === '') {
    patch.desktopHome = '';
  }

  const installDir = typeof source.dshInstallDir === 'string' ? source.dshInstallDir.trim() : '';
  const canonical = installDir ? resolveInstallDir(installDir) : null;
  if (canonical && commandForInstallDir(canonical)) {
    patch.dshInstallDir = canonical;
    patch.dshCommand = commandForInstallDir(canonical);
  } else {
    if (installDir) warnings.push(`DSH 安装目录不存在，已忽略：${installDir}`);
    const command = typeof source.dshCommand === 'string' ? source.dshCommand.trim() : '';
    if (command) {
      if (isFile(command)) patch.dshCommand = command;
      else warnings.push(`DSH 命令不存在，已忽略：${command}`);
    }
  }
  if (source.managerPort !== undefined && Number(source.managerPort) !== Number(store.settings.managerPort)) {
    warnings.push('管理端口不会随配置导入（需要重启管理器并手动修改）');
  }
  return patch;
}

/**
 * Merge (or replace) an exported manager configuration into this manager.
 * Instance data is never copied here: records are registered with their
 * recorded paths, missing data is reported as a warning.
 */
function importManagerConfig(store, payload, { mode = 'merge', applySettings = true } = {}) {
  const data = parseManagerExport(payload);
  const result = { ok: true, mode, imported: [], skipped: [], warnings: [], settingsApplied: [] };
  if (mode !== 'merge' && mode !== 'replace') mode = 'merge';
  result.mode = mode;

  if (mode === 'replace') {
    for (const current of store.list()) {
      store.remove(current.id);
      result.skipped.push({ name: current.name, reason: '已按“覆盖”模式移除原有实例记录（数据未删除）' });
    }
  }

  const usedPorts = new Set(store.list().map((item) => item.port).filter(Boolean));
  for (const item of data.instances) {
    if (!item || typeof item !== 'object') {
      result.skipped.push({ name: '?', reason: '记录格式无效' });
      continue;
    }
    const name = cleanName(item.name, typeof item.id === 'string' ? item.id : '实例');
    let id = safeId(item.id);
    if (id && store.get(id)) {
      result.skipped.push({ name, reason: '实例已存在（ID 相同）' });
      continue;
    }
    if (!id) id = store.newId(name);

    let layout;
    try {
      layout = resolveLayout({
        rootDir: item.layout && item.layout.rootDir,
        defaultRoot: store.instanceDir(id),
        paths: item.layout && typeof item.layout === 'object' ? item.layout : {},
      });
    } catch (error) {
      result.skipped.push({ name, reason: `目录规划无效：${error.message}` });
      continue;
    }
    if (layout.programDir && !isDirectory(layout.programDir)) {
      result.warnings.push(`实例「${name}」的程序目录不存在，已改为自动检测：${layout.programDir}`);
      layout.programDir = '';
    }
    try {
      validateLayout(layout, { dataDir: store.dataDir, instances: store.list() });
    } catch (error) {
      result.skipped.push({ name, reason: `目录规划无效：${error.message}` });
      continue;
    }

    let port = Number.isInteger(item.port) && item.port >= 1024 && item.port <= 65535 ? item.port : 0;
    if (port && usedPorts.has(port)) {
      result.warnings.push(`实例「${name}」的端口 ${port} 已被占用，改为自动分配`);
      port = 0;
    }
    if (port) usedPorts.add(port);

    if (!isDirectory(layout.rootDir) || !isDirectory(layout.homeDir)) {
      result.warnings.push(`实例「${name}」的目录尚未就位：${layout.rootDir}（需要导入该实例的数据，或在“编辑”中重新指定目录）`);
    }

    store.add({
      id,
      name,
      layout,
      port,
      autoStart: Boolean(item.autoStart),
      inherit: ownInherit(item.inherit),
      inheritedAt: typeof item.inheritedAt === 'string' ? item.inheritedAt : null,
    });
    result.imported.push({ id, name, port, rootDir: layout.rootDir, hasData: isDirectory(layout.homeDir) });
  }

  if (applySettings) {
    const patch = settingsPatch(store, data.settings, result.warnings);
    const keys = Object.keys(patch);
    if (keys.length) {
      store.updateSettings(patch);
      result.settingsApplied = keys;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Instance archives                                                   */
/* ------------------------------------------------------------------ */

function safeFileStem(value) {
  const stem = String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 48);
  return stem || 'instance';
}

function archiveFileName(name) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `dshm-${safeFileStem(name)}-${stamp}.zip`;
}

function archiveName(prefix, relPath) {
  const rel = relPath.split(path.sep).join('/');
  return rel ? `${prefix}/${rel}` : prefix;
}

function relativeName(root, target) {
  return path.relative(path.resolve(root), path.resolve(target)).split(path.sep).join('/');
}

/**
 * Walk a directory tree and collect files for the archive. Directory links are
 * never followed (their real location is exported through its own role), and
 * a few internal paths can be filtered out.
 */
function collectTree(root, prefix, { filter, onFile } = {}) {
  const stack = [''];
  const seen = new Set();
  while (stack.length) {
    const relDir = stack.pop();
    const dir = relDir ? path.join(root, relDir) : root;
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (filter && filter(rel, true)) continue;
        if (onFile) onFile(archiveName(prefix, rel), null, 0);
        stack.push(rel);
      } else if (entry.isFile()) {
        if (filter && filter(rel, false)) continue;
        const full = path.join(dir, entry.name);
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          continue;
        }
        if (onFile) onFile(archiveName(prefix, rel), full, size);
      }
    }
  }
}

/** Decide which paths inside the DSH home are skipped for the chosen options. */
function homeFilter(options) {
  return (rel, isDirectory) => {
    const parts = rel.split(path.sep);
    if (!options.modules && isDirectory && parts[parts.length - 1] === 'node_modules') return true;
    if (!options.credentials && !isDirectory && parts.length === 1 && parts[0] === '.credentials.yaml') return true;
    if (!isDirectory && parts[0].startsWith('.dshm-import')) return true;
    return false;
  };
}

/**
 * Export one instance into a ZIP file. The instance must be stopped; the
 * caller is responsible for that check.
 */
async function exportInstanceArchive({ instance, destFile, managerVersion = '', options = {} }) {
  const opts = {
    modules: options.modules !== false,
    logs: Boolean(options.logs),
    work: Boolean(options.work),
    credentials: options.credentials !== false,
  };
  const layout = instance.layout;
  const home = layout.homeDir;
  const sessionsInside = pathInside(layout.sessionsDir, home) && !samePath(layout.sessionsDir, home);
  const pluginsInside = pathInside(layout.pluginsDir, home) && !samePath(layout.pluginsDir, home);
  const entries = [];
  const stats = { files: 0, bytes: 0, directories: 0 };
  const push = (name, file, size) => {
    if (!file) {
      stats.directories += 1;
      entries.push({ name: name.endsWith('/') ? name : `${name}/` });
      return;
    }
    stats.files += 1;
    stats.bytes += size;
    entries.push({ name, path: file });
  };

  collectTree(home, 'home', { filter: homeFilter(opts), onFile: push });
  if (!sessionsInside && isDirectory(layout.sessionsDir)) {
    collectTree(layout.sessionsDir, 'sessions', { onFile: push });
  }
  if (!pluginsInside && isDirectory(layout.pluginsDir)) {
    collectTree(layout.pluginsDir, 'profile', { filter: homeFilter(opts), onFile: push });
  }
  if (opts.logs && isDirectory(layout.logsDir)) collectTree(layout.logsDir, 'logs', { onFile: push });
  if (opts.work && isDirectory(layout.workdir)) collectTree(layout.workdir, 'work', { onFile: push });

  const manifest = {
    kind: INSTANCE_KIND,
    version: FORMAT_VERSION,
    managerVersion,
    exportedAt: new Date().toISOString(),
    hostname: os.hostname(),
    instance: {
      id: instance.id,
      name: instance.name,
      layout,
      autoStart: Boolean(instance.autoStart),
      inherit: ownInherit(instance.inherit),
      inheritedAt: instance.inheritedAt || null,
    },
    options: opts,
    roles: {
      home: 'home',
      sessions: sessionsInside ? relativeName(home, layout.sessionsDir) : 'sessions',
      profile: pluginsInside ? relativeName(home, layout.pluginsDir) : 'profile',
    },
    stats: { files: stats.files, bytes: stats.bytes },
  };
  entries.unshift({ name: MANIFEST_NAME, data: `${JSON.stringify(manifest, null, 2)}\n` });

  await writeZip(destFile, entries, { compress: true });
  return { file: destFile, entries: entries.length, files: stats.files, bytes: stats.bytes, directories: stats.directories, manifest };
}

/** Move `source` contents into `target`, merging directories (files win). */
function mergeMove(source, target) {
  if (!isDirectory(source)) return;
  ensureDir(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      mergeMove(from, to);
      try {
        fs.rmdirSync(from);
      } catch {
        // Best effort: an empty directory that cannot be removed is harmless.
      }
      continue;
    }
    try {
      if (fs.existsSync(to)) fs.rmSync(to, { force: true });
      fs.renameSync(from, to);
    } catch {
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
    }
  }
}

/**
 * Import an instance archive as a new instance. Data is placed in a fresh
 * directory plan (default: `<data>/instances/<id>`), so archives are portable
 * between machines; the original paths are kept in the manifest for reference.
 */
async function importInstanceArchive({ store, zipFile, name = '', rootDir = '', managerVersion = '' }) {
  let manifestBuffer;
  try {
    manifestBuffer = await readZipEntry(zipFile, MANIFEST_NAME);
  } catch (error) {
    throw badRequest(`无法读取归档：${error.message}`);
  }
  if (!manifestBuffer) throw badRequest('不是实例归档（缺少 dshm-instance.json）');
  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8'));
  } catch {
    throw badRequest('实例归档的清单不是合法 JSON');
  }
  if (manifest.kind && manifest.kind !== INSTANCE_KIND) throw badRequest('不是实例归档（kind 不匹配）');
  if (Number(manifest.version) > FORMAT_VERSION) {
    throw badRequest(`归档版本 ${manifest.version} 高于当前管理器支持的版本 ${FORMAT_VERSION}`);
  }

  const displayName = cleanName(name || (manifest.instance && manifest.instance.name), '导入的实例');
  const id = store.newId(displayName);
  const defaultRoot = store.instanceDir(id);
  const layout = resolveLayout({ rootDir: rootDir || defaultRoot, defaultRoot });
  validateLayout(layout, { dataDir: store.dataDir, instances: store.list() });
  const rootExisted = fs.existsSync(layout.rootDir);
  ensureLayout(layout);

  const staging = path.join(layout.rootDir, `.dshm-import-${randomId(4)}`);
  ensureDir(staging);
  let extracted = { files: 0, bytes: 0, skipped: 0 };
  try {
    extracted = await extractZip(zipFile, staging);
    for (const role of ['home', 'sessions', 'profile', 'logs', 'work']) {
      const source = path.join(staging, role);
      if (!isDirectory(source)) continue;
      const target = {
        home: layout.homeDir,
        sessions: layout.sessionsDir,
        profile: layout.pluginsDir,
        logs: layout.logsDir,
        work: layout.workdir,
      }[role];
      mergeMove(source, target);
    }
    removeTree(staging);
    repairProfileModules(layout.pluginsDir);
  } catch (error) {
    try {
      removeTree(staging);
    } catch {
      // Ignore cleanup failures; the instance is not registered yet.
    }
    if (!rootExisted && pathInside(layout.rootDir, store.instancesDir)) {
      try {
        removeTree(layout.rootDir);
      } catch {
        // Ignore cleanup failures.
      }
    }
    throw error;
  }

  const instance = store.add({
    id,
    name: displayName,
    layout,
    port: 0,
    autoStart: false,
    inherit: ownInherit(manifest.instance && manifest.instance.inherit),
    inheritedAt: null,
  });
  return {
    instance,
    manifest,
    managerVersion,
    extracted: { ...extracted, homeDir: layout.homeDir, profileDir: layout.pluginsDir },
  };
}

/** Remove stale temp archives left by interrupted exports/imports. */
function cleanTempDir(dataDir, maxAgeMs = 24 * 60 * 60 * 1000) {
  const dir = path.join(dataDir, 'tmp');
  if (!isDirectory(dir)) return 0;
  let removed = 0;
  const now = Date.now();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    } catch {
      // Ignore files that vanish while cleaning.
    }
  }
  return removed;
}

module.exports = {
  MANAGER_KIND,
  INSTANCE_KIND,
  FORMAT_VERSION,
  MANIFEST_NAME,
  managerExportFileName,
  buildManagerExport,
  parseManagerExport,
  importManagerConfig,
  archiveFileName,
  exportInstanceArchive,
  importInstanceArchive,
  cleanTempDir,
};
