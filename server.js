'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Store } = require('./lib/store');
const { InstanceManager } = require('./lib/manager');
const { detectDshInstall, commandForInstallDir, resolveInstallDir } = require('./lib/dsh');
const { ensureDir, isDirectory, isFile } = require('./lib/util');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DSHM_DATA || path.join(ROOT, 'data'));
const TOKEN = require('node:crypto').randomBytes(24).toString('base64url');
const VERSION = require('./package.json').version;

function parseArgs(argv) {
  const options = { port: null, host: '127.0.0.1', openBrowser: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port' || arg === '-p') options.port = Number(argv[++index]);
    else if (arg === '--host') options.host = argv[++index];
    else if (arg === '--no-open') options.openBrowser = false;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node server.js [--port 53800] [--host 127.0.0.1] [--no-open]');
      process.exit(0);
    }
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
const store = new Store(DATA_DIR);
const manager = new InstanceManager(store, { log: (message) => console.log(message) });

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireManagerLock(dir) {
  const lockFile = path.join(dir, 'manager.lock');
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    }));
    fs.closeSync(fd);
    return lockFile;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner = null;
    try {
      const text = fs.readFileSync(lockFile, 'utf8').trim();
      try {
        owner = JSON.parse(text);
      } catch {
        owner = { pid: Number(text) };
      }
    } catch {
      owner = null;
    }
    if (owner && owner.hostname && owner.hostname !== os.hostname()) {
      // The folder was copied from another machine; a stale lock there is not ours.
      fs.rmSync(lockFile, { force: true });
      return acquireManagerLock(dir);
    }
    if (owner && processAlive(owner.pid)) {
      throw new Error(`已经有管理器在使用此数据目录（PID ${owner.pid}）。请先关闭它，或使用 DSHM_DATA 指定其他数据目录。`);
    }
    fs.rmSync(lockFile, { force: true });
    return acquireManagerLock(dir);
  }
}

let managerLock = null;

function sendJson(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readJsonBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.statusCode = 400;
    throw error;
  }
}

async function listDirectory(target) {
  const resolved = path.resolve(target);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isDirectory()) {
    const error = new Error('目标不是文件夹');
    error.statusCode = 400;
    throw error;
  }
  const dirents = await fs.promises.readdir(resolved, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents) {
    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        isDir = (await fs.promises.stat(path.join(resolved, dirent.name))).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    entries.push({
      name: dirent.name,
      path: path.join(resolved, dirent.name),
      hidden: dirent.name.startsWith('.'),
    });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
  const root = path.parse(resolved).root;
  return {
    path: resolved,
    parent: resolved === root ? null : path.dirname(resolved),
    root,
    roots: listRoots().entries,
    entries: entries.slice(0, 500),
    truncated: entries.length > 500,
  };
}

function listRoots() {
  const entries = [];
  const add = (name, target, icon = 'drive') => {
    try {
      if (!fs.statSync(target).isDirectory()) return;
    } catch {
      return;
    }
    if (entries.some((entry) => path.resolve(entry.path).toLowerCase() === path.resolve(target).toLowerCase())) return;
    entries.push({ name, path: path.resolve(target), icon });
  };
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code += 1) {
      const letter = String.fromCharCode(code);
      add(`${letter}: 磁盘`, `${letter}:\\`);
    }
    for (let code = 65; code <= 66; code += 1) {
      const letter = String.fromCharCode(code);
      if (fs.existsSync(`${letter}:\\`)) add(`${letter}: 磁盘`, `${letter}:\\`);
    }
  } else {
    add('根目录', '/');
  }
  add('用户主目录', os.homedir(), 'home');
  add('桌面', path.join(os.homedir(), 'Desktop'), 'folder');
  add('文档', path.join(os.homedir(), 'Documents'), 'folder');
  add('管理器数据', DATA_DIR, 'database');
  return { path: '', parent: null, root: '', entries, truncated: false, roots: true };
}

function validFolderName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return false;
  if (trimmed.length > 120) return false;
  return !/[<>:"/\\|?*\u0000-\u001f]/.test(trimmed);
}

function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
        detached: true,
        stdio: 'ignore',
      });
    }
    child.unref();
  } catch {
    // Opening the browser is best-effort; the printed URL still works.
  }
}

function openFolder(target) {
  ensureDir(target);
  let child;
  if (process.platform === 'win32') {
    child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: true });
  } else {
    child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], {
      detached: true,
      stdio: 'ignore',
    });
  }
  child.unref();
  return target;
}

function routeApi(req, res, pathname, url) {
  const method = req.method || 'GET';
  const instanceMatch = pathname.match(/^\/api\/instances\/([^/]+)(?:\/(start|stop|restart|logs|profile|open|sync-desktop))?$/);

  if (pathname === '/api/state' && method === 'GET') {
    return sendJson(res, 200, manager.state({
      port: currentPort,
      url: currentUrl,
      dataDir: DATA_DIR,
      host: currentHost,
    }));
  }

  if (pathname === '/api/settings' && method === 'GET') {
    const detected = manager.install({ fresh: true });
    let desktop = null;
    try {
      const info = manager.desktop();
      desktop = {
        homeDir: info.homeDir,
        profileDir: info.profileDir,
        present: info.present,
        totals: info.totals,
      };
    } catch (error) {
      desktop = { error: error.message };
    }
    return sendJson(res, 200, {
      dshCommand: store.settings.dshCommand,
      dshInstallDir: store.settings.dshInstallDir,
      desktopHome: store.settings.desktopHome,
      detected: {
        installDir: detected.installDir,
        command: detected.command,
        path: detected.command,
        source: detected.source,
      },
      desktop,
      dataDir: DATA_DIR,
      managerPort: currentPort,
      version: VERSION,
    });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    return readJsonBody(req).then((body) => {
      const patch = {};
      if (body.dshCommand !== undefined) {
        const command = String(body.dshCommand || '').trim();
        if (command && !isFile(command)) {
          const error = new Error(`文件不存在：${command}`);
          error.statusCode = 400;
          throw error;
        }
        patch.dshCommand = command;
      }
      if (body.dshInstallDir !== undefined) {
        const installDir = String(body.dshInstallDir || '').trim();
        if (installDir) {
          if (!isDirectory(installDir)) {
            const error = new Error(`安装目录不存在：${installDir}`);
            error.statusCode = 400;
            throw error;
          }
          const canonical = resolveInstallDir(installDir);
          if (!canonical || !commandForInstallDir(canonical)) {
            const error = new Error(`该目录下没有找到 DSH 启动器（resources\\runtime\\cli\\bin\\dsh.cmd）：${installDir}`);
            error.statusCode = 400;
            throw error;
          }
          patch.dshInstallDir = canonical;
          patch.dshCommand = commandForInstallDir(canonical);
        } else {
          patch.dshInstallDir = '';
        }
      }
      if (body.desktopHome !== undefined) {
        const desktopHome = String(body.desktopHome || '').trim();
        if (desktopHome && !isDirectory(desktopHome)) {
          const error = new Error(`桌面配置目录不存在：${desktopHome}`);
          error.statusCode = 400;
          throw error;
        }
        patch.desktopHome = desktopHome;
      }
      store.updateSettings(patch);
      manager.invalidateCommand();
      const detected = manager.install({ fresh: true });
      return sendJson(res, 200, { ok: true, detected, desktop: manager.desktop() });
    });
  }

  if (pathname === '/api/settings/detect' && method === 'POST') {
    const detected = detectDshInstall({});
    return readJsonBody(req).then((body) => {
      const desktopHome = String((body && body.desktopHome) || store.settings.desktopHome || '').trim();
      let desktop = null;
      try {
        desktop = manager.desktop();
      } catch {
        desktop = { homeDir: desktopHome, present: false };
      }
      return sendJson(res, 200, {
        installDir: detected.installDir,
        command: detected.command,
        path: detected.command,
        source: detected.source,
        desktop,
      });
    });
  }

  if (pathname === '/api/desktop' && method === 'GET') {
    const install = manager.install({ fresh: true });
    let desktop;
    try {
      desktop = manager.desktop({ withSize: true });
    } catch (error) {
      const wrapped = new Error(`读取桌面配置失败：${error.message}`);
      wrapped.statusCode = 500;
      throw wrapped;
    }
    return sendJson(res, 200, {
      desktop,
      install: { installDir: install.installDir, command: install.command, source: install.source },
      dataDir: DATA_DIR,
      instancesDir: path.join(DATA_DIR, 'instances'),
    });
  }

  if (pathname === '/api/open-data' && method === 'POST') {
    return sendJson(res, 200, { ok: true, path: openFolder(DATA_DIR) });
  }

  if (pathname === '/api/fs/list' && method === 'GET') {
    const target = url.searchParams.get('path');
    if (!target) return sendJson(res, 200, listRoots());
    if (!path.isAbsolute(target)) return sendText(res, 400, '需要绝对路径');
    return listDirectory(target).then((value) => sendJson(res, 200, value));
  }

  if (pathname === '/api/fs/mkdir' && method === 'POST') {
    return readJsonBody(req).then(async (body) => {
      const parent = String(body.parent || '').trim();
      const name = String(body.name || '').trim();
      if (!parent || !path.isAbsolute(parent)) {
        const error = new Error('父目录无效');
        error.statusCode = 400;
        throw error;
      }
      if (!validFolderName(name)) {
        const error = new Error('文件夹名称包含非法字符');
        error.statusCode = 400;
        throw error;
      }
      const target = path.join(path.resolve(parent), name);
      await fs.promises.mkdir(target);
      return sendJson(res, 201, { ok: true, path: target });
    });
  }

  if (pathname === '/api/instances' && method === 'POST') {
    return readJsonBody(req).then((body) => manager.create(body).then((value) => sendJson(res, 201, value)));
  }

  if (instanceMatch) {
    const id = decodeURIComponent(instanceMatch[1]);
    const action = instanceMatch[2];

    if (!action && method === 'GET') {
      return sendJson(res, 200, manager.describe(id));
    }

    if (!action && method === 'PATCH') {
      return readJsonBody(req).then((body) => manager.update(id, body).then((value) => sendJson(res, 200, value)));
    }

    if (!action && method === 'DELETE') {
      const deleteData = url.searchParams.get('deleteData') !== '0';
      return manager.remove(id, { deleteData }).then((value) => sendJson(res, 200, value));
    }

    if (action === 'start' && method === 'POST') {
      return manager.start(id).then((value) => sendJson(res, 200, value));
    }

    if (action === 'stop' && method === 'POST') {
      return manager.stop(id).then((value) => sendJson(res, 200, value));
    }

    if (action === 'restart' && method === 'POST') {
      return manager.restart(id).then((value) => sendJson(res, 200, value));
    }

    if (action === 'logs' && method === 'GET') {
      return sendJson(res, 200, { text: manager.logs(id, url.searchParams.get('lines')) });
    }

    if (action === 'profile' && method === 'GET') {
      return sendJson(res, 200, manager.profileInfo(id));
    }

    if (action === 'sync-desktop' && method === 'POST') {
      return readJsonBody(req).then((body) => manager.syncDesktop(id, body).then((value) => sendJson(res, 200, value)));
    }

    if (action === 'open' && method === 'POST') {
      return readJsonBody(req).then((body) => manager.openPath(id, body.kind).then((value) => sendJson(res, 200, value)));
    }
  }

  if (pathname === '/api/shutdown' && method === 'POST') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => {
      shutdown('管理器收到退出请求').finally(() => process.exit(0));
    }, 100);
    return undefined;
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

function serveStatic(req, res, pathname) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  };
  const entry = files[pathname];
  if (!entry) return false;
  const [file, type] = entry;
  let content;
  try {
    content = fs.readFileSync(path.join(PUBLIC_DIR, file));
  } catch {
    return false;
  }
  if (file === 'index.html') {
    content = Buffer.from(
      content
        .toString('utf8')
        .replaceAll('__DSHM_TOKEN__', TOKEN)
        .replaceAll('__DSHM_VERSION__', VERSION),
      'utf8',
    );
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': content.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(content);
  return true;
}

const server = http.createServer((req, res) => {
  let url;
  let pathname;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'Bad request path');
  }
  if (pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    const expectedOrigin = `http://${req.headers.host || ''}`;
    if (origin && origin !== expectedOrigin) {
      return sendJson(res, 403, { error: '跨站请求被拒绝' });
    }
    if (req.headers['x-dshm-token'] !== TOKEN) {
      return sendJson(res, 401, { error: '管理器令牌无效，请刷新页面' });
    }
    Promise.resolve()
      .then(() => routeApi(req, res, pathname, url))
      .catch((error) => {
        const status = error.statusCode || 500;
        if (status >= 500) console.error(error);
        if (!res.headersSent) sendJson(res, status, { error: error.message || String(error) });
        else res.end();
      });
    return;
  }
  if (serveStatic(req, res, pathname)) return;
  sendText(res, 404, 'Not found');
});

let currentPort = 0;
let currentHost = args.host;
let currentUrl = '';
let shuttingDown = false;

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[管理器] ${reason}，正在停止所有实例…`);
  try {
    await manager.stopAll();
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  console.log('[管理器] 已退出。');
}

function listenOn(port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function main() {
  ensureDir(DATA_DIR);
  managerLock = acquireManagerLock(DATA_DIR);
  const configuredPort = Number.isInteger(args.port) && args.port >= 0 ? args.port : store.settings.managerPort || 53800;
  let address = null;
  if (configuredPort === 0) {
    address = await listenOn(0, currentHost);
  } else {
    for (let offset = 0; offset < 30; offset += 1) {
      try {
        address = await listenOn(configuredPort + offset, currentHost);
        break;
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
      }
    }
    if (!address) throw new Error(`端口 ${configuredPort}–${configuredPort + 29} 均被占用`);
  }
  currentPort = typeof address === 'object' && address ? address.port : configuredPort;
  const displayHost = currentHost === '0.0.0.0' || currentHost === '::' ? '127.0.0.1' : currentHost;
  currentUrl = `http://${displayHost}:${currentPort}/`;

  const command = manager.command();
  console.log('');
  console.log('  DSH 实例管理器已启动');
  console.log(`  管理界面: ${currentUrl}`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`  DSH 命令: ${command.path || '未找到（请在设置中指定）'}${command.path ? `  [${command.source}]` : ''}`);
  console.log('  按 Ctrl+C 停止管理器（同时停止所有实例）');
  console.log('');

  if (args.openBrowser && store.settings.openBrowser !== false) openBrowser(currentUrl);
  manager.autoStartAll().catch((error) => console.error(error));
}

const shutdownAndExit = async (signal) => {
  await shutdown(`收到 ${signal}`);
  process.exit(0);
};
process.on('SIGINT', () => void shutdownAndExit('SIGINT'));
process.on('SIGTERM', () => void shutdownAndExit('SIGTERM'));
process.on('SIGHUP', () => void shutdownAndExit('SIGHUP'));
process.on('exit', () => {
  for (const rt of manager.runtime.values()) {
    if (rt.pid) {
      try {
        spawnSync('taskkill', ['/PID', String(rt.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        // Best effort.
      }
    }
  }
  if (managerLock) {
    try {
      fs.rmSync(managerLock, { force: true });
    } catch {
      // Best effort.
    }
  }
});

main().catch((error) => {
  console.error(`[管理器] 启动失败: ${error.message}`);
  process.exit(1);
});
