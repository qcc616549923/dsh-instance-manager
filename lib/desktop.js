'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  copyTree,
  directorySize,
  isDirectory,
  isFile,
  readJson,
  readText,
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
  const warnings = [];
  if (desktop.nodeModules.exists) {
    copyTree(desktop.nodeModules.path, path.join(profileDir, 'node_modules'));
    nodeModulesCopied = true;
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
  buildCredentialsDocument,
};
