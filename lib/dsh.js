'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { isFile, ensureDir, isDirectory } = require('./util');

const PACKAGE_NAMES = ['DeepSeek Harness', 'DSH'];

function commandCandidates(installDir) {
  if (!installDir) return [];
  const dir = path.resolve(installDir);
  if (process.platform === 'win32') {
    return [
      path.join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      path.join(dir, 'runtime', 'cli', 'bin', 'dsh.cmd'),
    ];
  }
  return [
    path.join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh'),
    path.join(dir, 'runtime', 'cli', 'bin', 'dsh'),
  ];
}

function commandForInstallDir(installDir) {
  for (const candidate of commandCandidates(installDir)) {
    if (isFile(candidate)) return candidate;
  }
  return '';
}

/** Resolve any DSH-related path (exe, cli package dir, app.asar, resources) to the install root. */
function resolveInstallDir(value) {
  if (!value) return '';
  let current;
  try {
    current = fs.statSync(value).isDirectory() ? path.resolve(value) : path.dirname(path.resolve(value));
  } catch {
    current = path.resolve(value);
    if (!isDirectory(current)) current = path.dirname(current);
  }
  for (let depth = 0; depth < 10; depth += 1) {
    const base = path.basename(current).toLowerCase();
    // `resources` and `app.asar` are layout components, never the install root.
    if (base === 'resources') {
      const parent = path.dirname(current);
      if (commandForInstallDir(parent)) return parent;
    }
    if (base === 'app.asar') {
      const root = path.dirname(path.dirname(current));
      if (commandForInstallDir(root)) return root;
    }
    if (commandForInstallDir(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // DSH_INSTALL_DIR may point inside app.asar; strip the archive path directly.
  const lower = String(value).toLowerCase();
  const marker = `${path.sep}app.asar${path.sep}`;
  const at = lower.indexOf(marker);
  if (at > 0) {
    const root = path.dirname(path.dirname(String(value).slice(0, at)));
    if (commandForInstallDir(root)) return root;
  }
  return '';
}

function deriveFromInstallDir(installDir) {
  const resolved = resolveInstallDir(installDir);
  if (!resolved) return null;
  return commandForInstallDir(resolved);
}

function registryInstallDirs() {
  if (process.platform !== 'win32') return [];
  const results = [];
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const key of keys) {
    const result = spawnSync('reg', ['query', key, '/s', '/f', 'DeepSeek Harness', '/d'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8000,
    });
    if (result.status !== 0 && !result.stdout) continue;
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const match = line.match(/^\s*(DisplayIcon|InstallLocation|UninstallString)\s+REG_[A-Z_]+\s+(.+)$/i);
      if (!match) continue;
      let value = match[2].trim().replace(/^"(.*)"$/, '$1');
      if (/deepseek harness\.exe/i.test(value)) value = value.replace(/,?\s*\d+$/, '');
      if (match[1].toLowerCase() === 'uninstallstring') value = path.dirname(value);
      results.push(value);
    }
  }
  return results;
}

function shortcutInstallDirs() {
  if (process.platform !== 'win32') return [];
  const folders = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(os.homedir(), 'Desktop'),
  ];
  const shortcuts = [];
  for (const folder of folders) {
    if (!isDirectory(folder)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.lnk$/i.test(entry.name)) continue;
      if (!/deepseek|dsh/i.test(entry.name)) continue;
      shortcuts.push(path.join(folder, entry.name));
      if (shortcuts.length >= 6) break;
    }
  }
  const results = [];
  for (const shortcut of shortcuts) {
    const script =
      "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:DSHM_LNK); " +
      "if($s.TargetPath){Write-Output $s.TargetPath}";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8000,
      env: { ...process.env, DSHM_LNK: shortcut },
    });
    const target = String(result.stdout || '').trim().split(/\r?\n/)[0];
    if (target) results.push(target);
  }
  return results;
}

function scanProgramsFolder() {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '';
  if (!base || !isDirectory(base)) return [];
  const results = [];
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      results.push(path.join(base, entry.name));
    }
  } catch {
    // Ignore unreadable Programs folders.
  }
  return results;
}

function commonInstallDirs() {
  const dirs = [];
  const add = (value) => {
    if (value) dirs.push(value);
  };
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData];
    for (const root of roots) {
      if (!root) continue;
      for (const name of PACKAGE_NAMES) add(path.join(root, name));
      add(path.join(root, 'Programs', 'DeepSeek Harness'));
      add(path.join(root, 'Programs', 'DSH'));
    }
    add('C:\\Soft\\DSH');
    add('C:\\Soft\\DeepSeek Harness');
    for (let code = 68; code <= 90; code += 1) {
      const drive = String.fromCharCode(code);
      if (!isDirectory(`${drive}:\\`)) continue;
      add(`${drive}:\\Soft\\DSH`);
      add(`${drive}:\\Soft\\DeepSeek Harness`);
      add(`${drive}:\\DeepSeek Harness`);
    }
    dirs.push(...scanProgramsFolder());
  } else {
    add('/usr/local/bin/dsh');
    add('/usr/bin/dsh');
    add('/opt/DeepSeek Harness');
  }
  return dirs;
}

function whereDsh() {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh'] : ['dsh'];
  const results = [];
  for (const name of names) {
    const result = spawnSync(command, [name], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (result.status !== 0) continue;
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const value = line.trim();
      if (value) results.push(value);
    }
  }
  return results;
}

/**
 * Find the DSH Desktop installation and the `dsh` launcher it carries.
 * Sources are tried from most explicit (saved settings, environment) to most
 * generic (registry, shortcuts, common folders, PATH).
 */
function detectDshInstall({ command = '', installDir = '', useShortcuts = true } = {}) {
  const candidates = [];
  const addInstall = (value, source) => {
    if (!value) return;
    const resolved = resolveInstallDir(value);
    if (resolved) candidates.push({ installDir: resolved, source, command: commandForInstallDir(resolved) });
  };
  const addCommand = (value, source) => {
    if (!value || !isFile(value)) return;
    candidates.push({ installDir: resolveInstallDir(value), source, command: path.resolve(value) });
  };

  if (command) addCommand(command, '设置中保存的 dsh 命令');
  addInstall(installDir, '设置中保存的安装目录');
  addInstall(process.env.DSHM_DSH_INSTALL_DIR, '环境变量 DSHM_DSH_INSTALL_DIR');
  addInstall(process.env.DSH_INSTALL_DIR, '环境变量 DSH_INSTALL_DIR');
  addInstall(process.env.DSH_NODE_EXECUTABLE, '当前 DSH 进程');
  addCommand(process.env.DSHM_DSH_COMMAND, '环境变量 DSHM_DSH_COMMAND');
  addCommand(process.env.DSH_CLI, '环境变量 DSH_CLI');

  for (const value of registryInstallDirs()) addInstall(value, 'Windows 注册表');
  for (const value of commonInstallDirs()) addInstall(value, '常见安装位置');
  for (const value of whereDsh()) addCommand(value, 'PATH 中的 dsh');
  if (candidates.length === 0 && useShortcuts) {
    for (const value of shortcutInstallDirs()) addInstall(value, '开始菜单快捷方式');
  }

  for (const candidate of candidates) {
    if (candidate.command && isFile(candidate.command)) return candidate;
  }
  const commandOnly = candidates.find((candidate) => candidate.command);
  if (commandOnly) return commandOnly;
  return {
    installDir: '',
    command: '',
    source: '未找到 DSH 安装目录，请在设置中手动指定',
  };
}

function detectDshCommand(configured = '', options = {}) {
  const detected = detectDshInstall({ command: configured, ...options });
  return { path: detected.command, source: detected.installDir ? `${detected.source}（${detected.installDir}）` : detected.source };
}

/** Capture the user's original DSH home before the manager sanitizes the child environment. */
function hostDshHome() {
  return process.env.DSHM_HOST_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function buildInstanceEnv(homeDir, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('DSH_')) delete env[key];
  }
  env.DSH_HOME = homeDir;
  env.DSH_AGENTS_HOME = path.join(homeDir, 'agents');
  env.FORCE_COLOR = '0';
  env.NO_COLOR = '1';
  Object.assign(env, extra);
  return env;
}

function copyCredentials(homeDir) {
  const source = path.join(hostDshHome(), '.credentials.yaml');
  const target = path.join(homeDir, '.credentials.yaml');
  if (!isFile(source)) return { copied: false, reason: '未找到当前 DSH 登录凭据' };
  ensureDir(homeDir);
  if (fs.existsSync(target)) return { copied: false, reason: '实例已存在凭据文件' };
  fs.copyFileSync(source, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // chmod is best-effort on Windows.
  }
  return { copied: true, reason: '已复制登录凭据' };
}

function spawnDsh(command, args, { cwd, env }) {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', 'call', command, ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runDshSync(command, args, { cwd, env, timeout = 90_000 } = {}) {
  if (process.platform === 'win32') {
    return spawnSync('cmd.exe', ['/d', '/s', '/c', 'call', command, ...args], {
      cwd,
      env,
      windowsHide: true,
      encoding: 'utf8',
      timeout,
    });
  }
  return spawnSync(command, args, {
    cwd,
    env,
    windowsHide: true,
    encoding: 'utf8',
    timeout,
  });
}

function killTree(pid) {
  if (!pid) return { ok: false, reason: 'no pid' };
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    return { ok: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
  }
  try {
    process.kill(pid, 'SIGTERM');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/**
 * Kill processes whose executable lives inside the given instance directories.
 * Some plugins (for example a bundled shell runtime) spawn detached helpers that
 * are no longer part of the instance's process tree when it stops.
 */
function killProcessesUnder(roots = []) {
  const list = (Array.isArray(roots) ? roots : [roots]).filter(Boolean).map((value) => path.resolve(value));
  if (!list.length || process.platform !== 'win32') return { ok: true, pids: [] };
  const script = [
    "$roots = $env:DSHM_KILL_ROOTS -split '\\|'",
    '$killed = @()',
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $p = $_.ExecutablePath',
    '  if (-not $p) { return }',
    '  foreach ($r in $roots) {',
    '    if ($p.StartsWith($r, [System.StringComparison]::OrdinalIgnoreCase)) {',
    '      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $killed += $_.ProcessId } catch {}',
    '      break',
    '    }',
    '  }',
    '}',
    '$killed -join ","',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, DSHM_KILL_ROOTS: list.join('|') },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  const pids = String(result.stdout || '')
    .trim()
    .split(',')
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));
  return { ok: result.status === 0, pids };
}

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (free) => {
      server.removeAllListeners();
      try {
        server.close();
      } catch {
        // Ignore close errors for a server that never listened.
      }
      resolve(free);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => finish(true));
    server.listen(port, host);
  });
}

function freePortOnRandom(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function findFreePort(preferred, host = '127.0.0.1') {
  if (Number.isInteger(preferred) && preferred > 0 && preferred < 65536) {
    if (await isPortFree(preferred, host)) return preferred;
  }
  return freePortOnRandom(host);
}

module.exports = {
  detectDshInstall,
  detectDshCommand,
  resolveInstallDir,
  commandForInstallDir,
  deriveFromInstallDir,
  hostDshHome,
  buildInstanceEnv,
  copyCredentials,
  spawnDsh,
  runDshSync,
  killTree,
  killProcessesUnder,
  isPortFree,
  findFreePort,
};
