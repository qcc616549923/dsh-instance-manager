'use strict';

const path = require('node:path');
const { ensureDir, ensureDirLink, isDirectory, pathInside, samePath } = require('./util');

const PROFILE_NAME = 'web';
const LEAF_FIELDS = ['sessionsDir', 'pluginsDir', 'workdir', 'logsDir'];

function defaultLayout(rootDir) {
  const root = path.resolve(rootDir);
  const homeDir = path.join(root, 'home');
  return {
    rootDir: root,
    homeDir,
    sessionsDir: path.join(homeDir, 'sessions'),
    pluginsDir: path.join(homeDir, 'profiles', PROFILE_NAME),
    workdir: path.join(root, 'work'),
    logsDir: path.join(root, 'logs'),
    programDir: '',
  };
}

function pickPath(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? path.resolve(text) : fallback;
}

/** Build the full directory plan from a root plus optional per-role overrides. */
function resolveLayout({ rootDir, paths = {}, defaultRoot, workdir } = {}) {
  const base = defaultLayout(rootDir || defaultRoot);
  const root = pickPath(rootDir, base.rootDir);
  const homeDir = pickPath(paths.homeDir, path.join(root, 'home'));
  return {
    rootDir: root,
    homeDir,
    sessionsDir: pickPath(paths.sessionsDir, path.join(homeDir, 'sessions')),
    pluginsDir: pickPath(paths.pluginsDir, path.join(homeDir, 'profiles', PROFILE_NAME)),
    workdir: pickPath(paths.workdir || workdir, path.join(root, 'work')),
    logsDir: pickPath(paths.logsDir, path.join(root, 'logs')),
    programDir: pickPath(paths.programDir, ''),
  };
}

/** Fill in missing fields for a stored instance, including pre-layout (v1) records. */
function normalizeLayout(instance, instanceDir) {
  const legacyRoot = path.join(instanceDir);
  if (!instance.layout || typeof instance.layout !== 'object') {
    const root = legacyRoot;
    const homeDir = path.join(root, 'home');
    return {
      rootDir: root,
      homeDir,
      sessionsDir: path.join(homeDir, 'sessions'),
      pluginsDir: path.join(homeDir, 'profiles', PROFILE_NAME),
      workdir: instance.workdir ? path.resolve(instance.workdir) : path.join(root, 'work'),
      logsDir: root,
      programDir: '',
    };
  }
  const layout = instance.layout;
  const root = pickPath(layout.rootDir, legacyRoot);
  const homeDir = pickPath(layout.homeDir, path.join(root, 'home'));
  return {
    rootDir: root,
    homeDir,
    sessionsDir: pickPath(layout.sessionsDir, path.join(homeDir, 'sessions')),
    pluginsDir: pickPath(layout.pluginsDir, path.join(homeDir, 'profiles', PROFILE_NAME)),
    workdir: pickPath(layout.workdir, instance.workdir ? path.resolve(instance.workdir) : path.join(root, 'work')),
    logsDir: pickPath(layout.logsDir, path.join(root, 'logs')),
    programDir: pickPath(layout.programDir, ''),
  };
}

function layoutOverlap(left, right) {
  const leftRoots = [left.rootDir, left.homeDir, left.workdir, left.sessionsDir, left.pluginsDir];
  const rightRoots = [right.rootDir, right.homeDir, right.workdir, right.sessionsDir, right.pluginsDir];
  for (const a of leftRoots) {
    for (const b of rightRoots) {
      if (pathInside(a, b) || pathInside(b, a)) return { a, b };
    }
  }
  return null;
}

/**
 * Validate a directory plan. Rejects role collisions, drive roots, workspace
 * directories that would be lost when an instance is deleted, and plans that
 * overlap another instance.
 */
function validateLayout(layout, { dataDir = '', instances = [] } = {}) {
  const fail = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  };
  const values = {
    rootDir: layout.rootDir,
    homeDir: layout.homeDir,
    sessionsDir: layout.sessionsDir,
    pluginsDir: layout.pluginsDir,
    workdir: layout.workdir,
    logsDir: layout.logsDir,
  };
  for (const [field, value] of Object.entries(values)) {
    if (!value || !path.isAbsolute(value)) fail(`目录必须是绝对路径：${field}`);
  }
  if (path.parse(layout.rootDir).root === layout.rootDir) fail('实例根目录不能是磁盘根目录，请选择或新建一个子目录');
  if (samePath(layout.rootDir, layout.homeDir)) fail('数据目录不能与实例根目录相同');
  if (samePath(layout.homeDir, layout.workdir)) fail('工作目录不能与数据目录相同');
  for (let i = 0; i < LEAF_FIELDS.length; i += 1) {
    for (let j = i + 1; j < LEAF_FIELDS.length; j += 1) {
      if (samePath(layout[LEAF_FIELDS[i]], layout[LEAF_FIELDS[j]])) {
        fail(`目录不能重复：${LEAF_FIELDS[i]} 与 ${LEAF_FIELDS[j]}`);
      }
    }
  }
  if (samePath(layout.sessionsDir, layout.homeDir)) fail('会话目录不能与数据目录相同');
  if (samePath(layout.pluginsDir, layout.homeDir)) fail('插件目录不能与数据目录相同');
  if (samePath(layout.logsDir, layout.homeDir)) fail('日志目录不能与数据目录相同');
  if (dataDir && samePath(layout.rootDir, dataDir)) fail('实例根目录不能直接使用管理器数据目录');
  if (dataDir && pathInside(layout.workdir, dataDir) && !pathInside(layout.workdir, layout.rootDir)) {
    fail('工作目录不能位于管理器的 data 目录内（该目录可能随实例数据一起清理）');
  }
  if (layout.programDir && !isDirectory(layout.programDir)) {
    fail(`程序目录不存在：${layout.programDir}`);
  }
  for (const other of instances) {
    if (!other.layout) continue;
    const overlap = layoutOverlap(layout, other.layout);
    if (overlap) {
      fail(`目录与实例「${other.name}」重叠：${overlap.a} ↔ ${overlap.b}`);
    }
  }
  return layout;
}

/**
 * Create the plan's directories and wire custom session/plugin locations into
 * the DSH home with directory junctions, so DSH still finds them at its
 * standard paths while the user can keep them anywhere.
 */
function ensureLayout(layout) {
  for (const dir of [layout.rootDir, layout.homeDir, layout.workdir, layout.logsDir, layout.sessionsDir, layout.pluginsDir]) {
    ensureDir(dir);
  }
  ensureDir(path.join(layout.homeDir, 'profiles'));
  ensureDir(path.join(layout.homeDir, 'agents'));
  const links = [];
  links.push({
    role: 'sessions',
    link: path.join(layout.homeDir, 'sessions'),
    target: layout.sessionsDir,
    ...ensureDirLink(path.join(layout.homeDir, 'sessions'), layout.sessionsDir),
  });
  links.push({
    role: 'plugins',
    link: path.join(layout.homeDir, 'profiles', PROFILE_NAME),
    target: layout.pluginsDir,
    ...ensureDirLink(path.join(layout.homeDir, 'profiles', PROFILE_NAME), layout.pluginsDir),
  });
  return links;
}

function layoutsOverlap(left, right) {
  return Boolean(layoutOverlap(left, right));
}

module.exports = {
  PROFILE_NAME,
  defaultLayout,
  resolveLayout,
  normalizeLayout,
  validateLayout,
  ensureLayout,
  layoutsOverlap,
};
