'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  copyTree,
  directorySize,
  isDirectory,
  isFile,
  pathInside,
  readJson,
  readText,
  samePath,
  writeJsonAtomic,
  writeTextAtomic,
} = require('./util');

const PROFILE_NAME = 'web';
const DESKTOP_PROFILE = 'desktop';

/** Resolve the DSH home that holds the Desktop profile (the "core" configuration). */
function resolveDesktopHome(configured = '') {
  const candidates = [
    configured,
    process.env.DSHM_DESKTOP_HOME,
    process.env.DSH_HOME,
    path.join(os.homedir(), '.dsh'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (isDirectory(resolved)) return resolved;
  }
  const fallback = configured || process.env.DSHM_DESKTOP_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.resolve(fallback);
}

/** Split a YAML document into top-level `key:` blocks, preserving original lines. */
function splitTopLevelSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = new Map();
  let current = null;
  for (const line of lines) {
    const top = line.match(/^([A-Za-z_][\w.-]*):\s*(.*)$/);
    if (top) {
      current = top[1];
      sections.set(current, { header: line, lines: [], inline: top[2].trim() });
      continue;
    }
    if (current) sections.get(current).lines.push(line);
  }
  return sections;
}

function refNamesFromBlock(lines) {
  const names = [];
  let indent = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (!match) continue;
    if (indent === null) indent = match[1].length;
    if (match[1].length !== indent) continue;
    names.push(match[2]);
  }
  return names;
}

/** Read the API-key reference names stored in a credentials document. Values are never returned. */
function readCredentialRefs(file) {
  const text = readText(file, '');
  if (!text) return { names: [], block: [], version: 1 };
  const sections = splitTopLevelSections(text);
  const versionMatch = text.match(/^version:\s*(\d+)\s*$/m);
  const refs = sections.get('refs');
  if (!refs) return { names: [], block: [], version: versionMatch ? Number(versionMatch[1]) : 1, text };
  if (refs.inline && refs.inline !== '{}') {
    return { names: [], block: [], version: versionMatch ? Number(versionMatch[1]) : 1, text };
  }
  const block = refs.lines.filter((line) => line.trim() !== '');
  return {
    names: refNamesFromBlock(block),
    block,
    version: versionMatch ? Number(versionMatch[1]) : 1,
    text,
  };
}

function patchEntryIds(text) {
  const ids = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^-\s+id:\s*["']?([A-Za-z0-9@/_.:-]+)["']?\s*$/);
    if (match) ids.push(match[1]);
  }
  return ids;
}

function patchHasContent(text) {
  const stripped = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter(Boolean)
    .join('\n');
  return stripped !== '' && stripped !== '[]';
}

/** Inspect the Desktop profile: installed plugin bundles, config layer, and API-key names. */
function inspectDesktop({ home = '', withSize = true } = {}) {
  const homeDir = resolveDesktopHome(home);
  const profileDir = path.join(homeDir, 'profiles', DESKTOP_PROFILE);
  const manifestFile = path.join(profileDir, 'package.json');
  const manifest = readJson(manifestFile, null) || {};
  const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
  const bundles =
    manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
      ? manifest.dsh.profile.bundles.filter((name) => typeof name === 'string')
      : [];
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const homePatchFile = path.join(homeDir, 'cordis.patch.yml');
  const credentialsFile = path.join(homeDir, '.credentials.yaml');
  const nodeModulesDir = path.join(profileDir, 'node_modules');
  const patchText = readText(patchFile, '');
  const homePatchText = readText(homePatchFile, '');
  const refs = readCredentialRefs(credentialsFile);
  let nodeModulesBytes = 0;
  if (withSize && isDirectory(nodeModulesDir)) {
    try {
      nodeModulesBytes = directorySize(nodeModulesDir, 80_000).bytes;
    } catch {
      nodeModulesBytes = 0;
    }
  }
  return {
    homeDir,
    profileDir,
    present: isFile(manifestFile),
    manifestFile,
    profileName: DESKTOP_PROFILE,
    plugins: Object.entries(dependencies)
      .map(([name, spec]) => ({ name, spec: String(spec) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    bundles,
    config: {
      file: patchFile,
      exists: isFile(patchFile),
      hasContent: patchHasContent(patchText),
      entryIds: patchEntryIds(patchText),
    },
    homeConfig: {
      file: homePatchFile,
      exists: isFile(homePatchFile),
      hasContent: patchHasContent(homePatchText),
    },
    credentials: {
      file: credentialsFile,
      exists: isFile(credentialsFile),
      names: refs.names,
    },
    nodeModules: {
      path: nodeModulesDir,
      exists: isDirectory(nodeModulesDir),
      bytes: nodeModulesBytes,
    },
    lockFile: path.join(profileDir, 'pnpm-lock.yaml'),
    totals: {
      plugins: Object.keys(dependencies).length,
      bundles: bundles.length,
      credentials: refs.names.length,
      configEntries: patchEntryIds(patchText).length,
    },
  };
}

function buildCredentialsDocument(version, blockLines) {
  const body = blockLines.length ? `refs:\n${blockLines.join('\n')}\n` : 'refs: {}\n';
  return `version: ${version || 1}\n${body}`;
}

/** Insert missing reference lines into an existing document without touching other sections. */
function mergeRefsIntoDocument(text, desktopBlock) {
  const lines = String(text || '').split(/\r?\n/);
  const refsIndex = lines.findIndex((line) => /^refs:\s*(.*)$/.test(line));
  const sourceNames = new Set(
    desktopBlock
      .map((line) => line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/))
      .filter(Boolean)
      .map((match) => match[1]),
  );
  if (refsIndex === -1) {
    const versionMissing = !/^version:\s*\d+\s*$/m.test(text);
    const prefix = versionMissing ? 'version: 1\n' : '';
    const trimmed = text && !text.endsWith('\n') ? `${text}\n` : text;
    return `${prefix}${trimmed || ''}refs:\n${desktopBlock.join('\n')}\n`;
  }
  const header = lines[refsIndex];
  const inline = header.match(/^refs:\s*(.*)$/)[1].trim();
  if (inline && inline !== '{}') return null;
  if (inline === '{}') lines[refsIndex] = 'refs:';
  let end = refsIndex + 1;
  const existingNames = new Set();
  while (end < lines.length) {
    const line = lines[end];
    if (!line.trim()) {
      end += 1;
      continue;
    }
    if (!/^\s+/.test(line)) break;
    const name = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (name) existingNames.add(name[1]);
    end += 1;
  }
  const additions = desktopBlock.filter((line) => {
    const name = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    return name && sourceNames.has(name[1]) && !existingNames.has(name[1]);
  });
  if (!additions.length) return { text, added: 0 };
  const before = lines.slice(0, end);
  while (before.length > refsIndex + 1 && before[before.length - 1].trim() === '') before.pop();
  const after = lines.slice(end);
  return {
    text: [...before, ...additions, ...(after.length ? ['', ...after] : [])].join('\n').replace(/\n{3,}/g, '\n\n'),
    added: additions.length,
  };
}

/** Merge Desktop API keys into the instance credential store without overwriting existing keys or records. */
function applyCredentials(desktop, instanceHomeDir) {
  const target = path.join(instanceHomeDir, '.credentials.yaml');
  const sourceRefs = readCredentialRefs(desktop.credentials.file);
  if (!sourceRefs.names.length) return { ok: false, reason: '桌面配置中没有可复制的 API KEY' };
  const existingText = readText(target, '');
  if (!existingText.trim()) {
    writeTextAtomic(target, buildCredentialsDocument(sourceRefs.version, sourceRefs.block), { mode: 0o600 });
    return { ok: true, added: sourceRefs.names.length, names: sourceRefs.names };
  }
  const merged = mergeRefsIntoDocument(existingText, sourceRefs.block);
  if (merged === null) {
    return { ok: false, reason: '实例凭据文件的 refs 不是块格式，请手动合并 / 合并前请检查' };
  }
  if (!merged.added) return { ok: true, added: 0, reason: '实例已拥有这些 API KEY' };
  writeTextAtomic(target, merged.text, { mode: 0o600 });
  return { ok: true, added: merged.added };
}

/** Copy the Desktop config layer(s) into the instance profile and home. */
function applyConfig(desktop, { profileDir, homeDir }) {
  const copied = [];
  if (desktop.config.exists && desktop.config.hasContent) {
    writeTextAtomic(path.join(profileDir, 'cordis.patch.yml'), readText(desktop.config.file, ''), { mode: 0o600 });
    copied.push({ target: 'profile', entries: desktop.config.entryIds.length });
  }
  if (desktop.homeConfig.exists && desktop.homeConfig.hasContent) {
    writeTextAtomic(path.join(homeDir, 'cordis.patch.yml'), readText(desktop.homeConfig.file, ''), { mode: 0o600 });
    copied.push({ target: 'home' });
  }
  return copied.length
    ? { ok: true, copied }
    : { ok: false, reason: '桌面配置没有可复制的配置层' };
}

function uniqueBundleOrder(bundles) {
  const ordered = [];
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...bundles]) {
    if (typeof name !== 'string' || !name || ordered.includes(name)) continue;
    ordered.push(name);
  }
  return ordered;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function remapInside(target, fromDir, toDir) {
  if (!target || !fromDir || !toDir) return null;
  if (!pathInside(target, fromDir)) return null;
  return path.join(toDir, path.relative(path.resolve(fromDir), path.resolve(target)));
}

function removeLink(linkPath) {
  try {
    fs.unlinkSync(linkPath);
    return;
  } catch {
    // Junctions cannot always be unlinked; rmdir removes the link, not its target.
  }
  try {
    fs.rmdirSync(linkPath);
  } catch {
    try {
      fs.rmSync(linkPath, { recursive: false, force: true });
    } catch {
      // Leave the link in place; the caller reports it as unrepaired.
    }
  }
}

function replaceProfilePaths(value, fromDir, toDir) {
  if (typeof value === 'string') {
    const remapped = remapInside(value, fromDir, toDir);
    if (remapped) return remapped;
    return value.replace(new RegExp(escapeRegExp(fromDir), 'gi'), toDir);
  }
  if (Array.isArray(value)) return value.map((item) => replaceProfilePaths(item, fromDir, toDir));
  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      const nextKey = replaceProfilePaths(key, fromDir, toDir);
      next[nextKey] = replaceProfilePaths(item, fromDir, toDir);
    }
    return next;
  }
  return value;
}

/** Volume (drive) a path lives on. Empty string when the path has no root. */
function volumeOf(target) {
  if (!target) return '';
  const root = path.parse(path.resolve(String(target))).root;
  return root ? root.toLowerCase() : '';
}

/** `store-dir` from an ini/npmrc file, if the file sets it. */
function readIniStoreDir(file) {
  const text = readText(file, '');
  if (!text) return '';
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*store-dir\s*=\s*(.+?)\s*$/i);
    if (match) return match[1].replace(/^["']|["']$/g, '');
  }
  return '';
}

/** The `store-dir` pnpm would resolve for this profile (highest priority first). */
function configuredStoreDir(profileDir) {
  const globalRc = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'pnpm', 'config', 'rc');
  const candidates = [
    process.env.npm_config_store_dir || process.env.NPM_CONFIG_STORE_DIR || '',
    readIniStoreDir(path.join(profileDir, '.npmrc')),
    readIniStoreDir(path.join(os.homedir(), '.npmrc')),
    readIniStoreDir(globalRc),
  ];
  return candidates.find(Boolean) || '';
}

/** Expand the `~` and `$VAR` forms npmrc values may use. */
function expandConfigPath(value, baseDir) {
  const expanded = String(value || '')
    .trim()
    .replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (raw, braced, plain) => process.env[braced || plain] || raw);
  if (/^~(?=$|[\\/])/.test(expanded)) return path.join(os.homedir(), expanded.slice(1));
  return path.resolve(baseDir, expanded);
}

/** Store layout version pnpm uses in `<volume>\.pnpm-store\v<N>`. */
function pnpmStoreVersion(recorded, metadata) {
  const fromPath = /^v(\d+)$/i.exec(path.basename(String(recorded || '')));
  if (fromPath) return fromPath[1];
  const fromManager = /^pnpm@(\d+)/i.exec(String((metadata && metadata.packageManager) || ''));
  if (!fromManager) return '';
  const major = Number(fromManager[1]);
  // pnpm keeps store v3 up to v9; from v10 the store major tracks the pnpm major.
  return String(major >= 10 ? major : 3);
}

/**
 * The store pnpm will actually use for this profile. pnpm refuses to use a
 * store it cannot hard link from (another volume on Windows) and silently
 * switches to `<volume>\.pnpm-store\v<N>`, so a recorded cross-volume store is
 * what makes pnpm abort with ERR_PNPM_UNEXPECTED_STORE.
 */
function resolveExpectedStoreDir(profileDir, modulesDir, recorded, metadata) {
  const configured = configuredStoreDir(profileDir);
  if (configured) {
    const absolute = expandConfigPath(configured, profileDir);
    if (volumeOf(absolute) === volumeOf(modulesDir)) return absolute;
  }
  const version = pnpmStoreVersion(recorded, metadata);
  const root = path.parse(path.resolve(modulesDir)).root;
  if (!version || !root) return '';
  return path.join(root, '.pnpm-store', `v${version}`);
}

/**
 * Make a node_modules tree copied from another profile self-consistent: point
 * pnpm's recorded virtual store at this profile, remap links that still point
 * at the source profile, drop/dereference external workspace links, and move a
 * recorded cross-volume store to the store pnpm will pick for this volume.
 * Without this, pnpm refuses plugin install/uninstall with
 * ERR_PNPM_UNEXPECTED_VIRTUAL_STORE / ERR_PNPM_UNEXPECTED_STORE.
 */
function repairProfileModules(profileDir, { maxDepth = 24 } = {}) {
  const modulesDir = path.join(profileDir, 'node_modules');
  if (!isDirectory(modulesDir)) return { ok: true, skipped: true };
  const modulesFile = path.join(modulesDir, '.modules.yaml');
  let metadata = null;
  try {
    metadata = readJson(modulesFile, null);
  } catch {
    metadata = null;
  }
  const expectedVirtualStore = path.join(modulesDir, '.pnpm');
  const oldVirtualStore = metadata && typeof metadata.virtualStoreDir === 'string' ? metadata.virtualStoreDir : '';
  const oldModulesDir = oldVirtualStore ? path.dirname(oldVirtualStore) : '';
  const oldProfileDir = oldModulesDir ? path.dirname(oldModulesDir) : '';
  const manifest = readJson(path.join(profileDir, 'package.json'), null) || {};
  const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
  const result = {
    ok: true,
    skipped: false,
    metadataUpdated: false,
    storeDirUpdated: false,
    stateUpdated: false,
    linksRemapped: 0,
    linksDereferenced: 0,
    linksRemoved: 0,
    oldVirtualStoreDir: oldVirtualStore || null,
    oldStoreDir: metadata && typeof metadata.storeDir === 'string' ? metadata.storeDir || null : null,
    storeDir: metadata && typeof metadata.storeDir === 'string' ? metadata.storeDir || null : null,
  };

  if (metadata) {
    let metadataChanged = false;
    if (oldVirtualStore && !samePath(oldVirtualStore, expectedVirtualStore)) {
      metadata.virtualStoreDir = expectedVirtualStore;
      metadataChanged = true;
      result.metadataUpdated = true;
    }
    const recordedStore = typeof metadata.storeDir === 'string' ? metadata.storeDir : '';
    // Only a cross-volume store is rewritten: pnpm overrides exactly those with
    // the store of the profile's own volume, so this is the only case we can
    // predict. A same-volume custom store must be left untouched.
    if (recordedStore && volumeOf(recordedStore) !== volumeOf(modulesDir)) {
      const nextStore = resolveExpectedStoreDir(profileDir, modulesDir, recordedStore, metadata);
      if (nextStore && !samePath(nextStore, recordedStore)) {
        metadata.storeDir = nextStore;
        metadataChanged = true;
        result.storeDirUpdated = true;
      }
    }
    if (metadataChanged) writeJsonAtomic(modulesFile, metadata);
    if (typeof metadata.storeDir === 'string') result.storeDir = metadata.storeDir || null;
  }

  const stateFile = path.join(modulesDir, '.pnpm-workspace-state-v1.json');
  if (isFile(stateFile) && oldProfileDir && !samePath(oldProfileDir, profileDir)) {
    try {
      const state = readJson(stateFile, null);
      if (state) {
        const rewritten = replaceProfilePaths(state, oldProfileDir, profileDir);
        if (JSON.stringify(rewritten) !== JSON.stringify(state)) {
          writeJsonAtomic(stateFile, rewritten);
          result.stateUpdated = true;
        }
      }
    } catch {
      // A corrupt state file is regenerated by pnpm; metadata is what blocks operations.
    }
  }

  if (oldVirtualStore && !samePath(oldModulesDir, modulesDir)) {
    const walk = (dir, depth) => {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          let rawTarget;
          try {
            rawTarget = fs.readlinkSync(full);
          } catch {
            continue;
          }
          const absolute = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(dir, rawTarget);
          let mapped = remapInside(absolute, oldModulesDir, modulesDir);
          if (!mapped) mapped = remapInside(absolute, oldProfileDir, profileDir);
          if (mapped && !samePath(mapped, absolute)) {
            removeLink(full);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            try {
              fs.symlinkSync(mapped, full, 'junction');
              result.linksRemapped += 1;
            } catch {
              result.linksRemoved += 1;
            }
            continue;
          }
          if (mapped) continue;
          // External link (usually a workspace/link: dependency): copy real
          // content for declared dependencies, drop stale links otherwise.
          const name = path.basename(full);
          const declared = Object.hasOwn(dependencies, name) ? String(dependencies[name]) : '';
          const cycle = pathInside(profileDir, absolute) || pathInside(absolute, profileDir);
          if (declared && /^(link|file|workspace):/i.test(declared) && isDirectory(absolute) && !cycle) {
            removeLink(full);
            copyTree(absolute, full);
            result.linksDereferenced += 1;
          } else if (!declared || !isDirectory(absolute)) {
            removeLink(full);
            result.linksRemoved += 1;
          }
          continue;
        }
        if (entry.isDirectory()) walk(full, depth + 1);
      }
    };
    walk(modulesDir, 0);
  }

  result.changed =
    result.metadataUpdated ||
    result.storeDirUpdated ||
    result.stateUpdated ||
    result.linksRemapped > 0 ||
    result.linksDereferenced > 0 ||
    result.linksRemoved > 0;
  return result;
}

/** Merge Desktop plugin dependencies + bundle list into the instance profile, then copy node_modules. */
function applyPlugins(desktop, { profileDir }) {
  if (!desktop.present) return { ok: false, reason: '未找到桌面 profile，无法复制插件' };
  const manifestFile = path.join(profileDir, 'package.json');
  const existing = readJson(manifestFile, null) || {};
  const existingDeps = existing.dependencies && typeof existing.dependencies === 'object' ? existing.dependencies : {};
  const existingBundles =
    existing.dsh && existing.dsh.profile && Array.isArray(existing.dsh.profile.bundles) ? existing.dsh.profile.bundles : [];
  const manifest = {
    ...existing,
    name: existing.name || 'dsh-profile-web',
    private: true,
    dependencies: { ...existingDeps, ...Object.fromEntries(desktop.plugins.map((plugin) => [plugin.name, plugin.spec])) },
    dsh: {
      ...(existing.dsh || {}),
      profile: {
        ...((existing.dsh && existing.dsh.profile) || {}),
        bundles: uniqueBundleOrder([...existingBundles, ...desktop.bundles]),
      },
    },
  };
  let nodeModulesCopied = false;
  let moduleRepair = null;
  const warnings = [];
  if (desktop.nodeModules.exists) {
    copyTree(desktop.nodeModules.path, path.join(profileDir, 'node_modules'));
    nodeModulesCopied = true;
    try {
      moduleRepair = repairProfileModules(profileDir);
      if (moduleRepair.linksRemoved > 0) {
        warnings.push(`已移除 ${moduleRepair.linksRemoved} 个不属于本实例的链接依赖`);
      }
    } catch (error) {
      warnings.push(`修复插件依赖元数据失败：${error.message}`);
    }
  } else if (Object.keys(manifest.dependencies).length > 0) {
    warnings.push('桌面 profile 没有 node_modules，第三方插件可能无法加载；可在实例内重新安装插件');
  }
  const lockFile = path.join(profileDir, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockFile) && isFile(desktop.lockFile)) {
    try {
      fs.copyFileSync(desktop.lockFile, lockFile);
    } catch {
      // A missing lock file only affects future installs.
    }
  }
  // Write the manifest last so a partial node_modules copy never claims dependencies it lacks.
  writeJsonAtomic(manifestFile, manifest);
  return {
    ok: true,
    dependencies: Object.keys(manifest.dependencies).length,
    bundles: manifest.dsh.profile.bundles,
    nodeModulesCopied,
    nodeModulesBytes: desktop.nodeModules.bytes,
    moduleRepair,
    warnings,
  };
}

module.exports = {
  PROFILE_NAME,
  DESKTOP_PROFILE,
  resolveDesktopHome,
  readCredentialRefs,
  patchEntryIds,
  patchHasContent,
  inspectDesktop,
  applyCredentials,
  applyConfig,
  applyPlugins,
  repairProfileModules,
  resolveExpectedStoreDir,
  buildCredentialsDocument,
};
