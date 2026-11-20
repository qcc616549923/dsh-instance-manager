'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForExit(child, timeout = 12_000) {
  return Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(timeout),
  ]);
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A synthetic Desktop profile so inheritance can be tested without touching the real one. */
function makeDesktopFixture(baseDir) {
  const home = path.join(baseDir, 'desktop-home');
  write(
    path.join(home, '.credentials.yaml'),
    ['version: 1', 'records:', '  client-connection/browser-session:', '    kind: browser-session', '    payload:', '      secret: record-secret', 'refs:', '  TEST_API_KEY: sk-smoke', ''].join('\n'),
  );
  write(
    path.join(home, 'profiles', 'desktop', 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      },
      null,
      2,
    ),
  );
  write(
    path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
    '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n  config:\n    transcriptView: standard\n',
  );
  return home;
}

test('create → inherit → start → open → stop → delete with a custom directory plan', { timeout: 180_000 }, async (t) => {
  const temp = path.join(__dirname, '.tmp', `smoke-${Date.now()}`);
  const dataDir = path.join(temp, 'data');
  const rootDir = path.join(temp, 'instance-root');
  const sessionsDir = path.join(temp, 'custom-sessions');
  const pluginsDir = path.join(temp, 'custom-plugins');
  const workdir = path.join(temp, 'work');
  const desktopHome = makeDesktopFixture(temp);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });

  const server = spawn(process.execPath, ['server.js', '--port', '0', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, DSHM_DATA: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let stderr = '';
  server.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  let token = '';
  let baseUrl = '';
  let instanceId = '';

  const api = async (pathname, options = {}) => {
    const headers = { 'x-dshm-token': token, ...(options.headers || {}) };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(new URL(pathname, baseUrl), { ...options, headers });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) throw new Error(`${pathname} → ${response.status}: ${text}`);
    return data;
  };

  t.after(async () => {
    if (token) {
      try {
        await api('/api/shutdown', { method: 'POST' });
      } catch {
        // Already stopped or shutting down.
      }
    }
    await waitForExit(server);
    if (server.exitCode === null && process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true });
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const match = output.match(/管理界面: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) {
        baseUrl = match[1];
        break;
      }
      await sleep(200);
    }
    assert.ok(baseUrl, `管理器未启动：\n${output}\n${stderr}`);

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    const tokenMatch = html.match(/name="dshm-token" content="([^"]+)"/);
    assert.ok(tokenMatch, '页面未注入管理器令牌');
    token = tokenMatch[1];

    const state = await api('/api/state');
    assert.equal(state.instances.length, 0);
    assert.ok(state.manager.port > 0);
    assert.ok(state.manager.dshInstallDir || state.manager.dshCommand, '应自动检测到 DSH 安装');
    assert.equal(typeof state.manager.desktop, 'object');

    const desktop = await api('/api/desktop');
    assert.equal(typeof desktop.desktop.homeDir, 'string');
    assert.equal(typeof desktop.instancesDir, 'string');

    const detected = await api('/api/settings/detect', { method: 'POST' });
    assert.ok(detected.installDir || detected.command, '自动检测应返回 DSH 安装目录或命令');

    const settings = await api('/api/settings', { method: 'PUT', body: { desktopHome } });
    assert.equal(settings.ok, true);
    assert.equal(settings.desktop.present, true);

    const instance = await api('/api/instances', {
      method: 'POST',
      body: {
        name: 'smoke',
        rootDir,
        paths: { sessionsDir, pluginsDir, workdir },
        autoStart: false,
        inherit: { plugins: false, credentials: true, config: true },
      },
    });
    instanceId = instance.id;
    assert.equal(instance.status, 'stopped');
    assert.ok(instance.port >= 1024);
    assert.equal(instance.rootDir, path.resolve(rootDir));
    assert.equal(instance.homeDir, path.join(path.resolve(rootDir), 'home'));
    assert.equal(instance.sessionsDir, path.resolve(sessionsDir));
    assert.equal(instance.pluginsDir, path.resolve(pluginsDir));
    assert.equal(instance.workdir, path.resolve(workdir));
    assert.equal(instance.logsDir, path.join(path.resolve(rootDir), 'logs'));
    assert.deepEqual(instance.inherit, { plugins: false, credentials: true, config: true });
    assert.equal(instance.inheritance.credentials.added, 1);
    assert.equal(instance.inheritance.warnings.length, 0);
    assert.match(fs.readFileSync(path.join(instance.homeDir, '.credentials.yaml'), 'utf8'), /TEST_API_KEY: sk-smoke/);
    assert.match(fs.readFileSync(path.join(instance.pluginsDir, 'cordis.patch.yml'), 'utf8'), /ui-chat/);
    assert.equal(fs.lstatSync(path.join(instance.homeDir, 'sessions')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(instance.homeDir, 'profiles', 'web')).isSymbolicLink(), true);

    const detail = await api(`/api/instances/${encodeURIComponent(instanceId)}/profile`);
    assert.equal(detail.sessionsDir, path.resolve(sessionsDir));
    assert.equal(detail.pluginsDir, path.resolve(pluginsDir));
    assert.equal(detail.inherit.credentials, true);

    const workdir2 = path.join(temp, 'work-2');
    fs.mkdirSync(workdir2, { recursive: true });
    const updated = await api(`/api/instances/${encodeURIComponent(instanceId)}`, {
      method: 'PATCH',
      body: { workdir: workdir2, autoStart: false },
    });
    assert.equal(updated.workdir, path.resolve(workdir2));

    const started = await api(`/api/instances/${encodeURIComponent(instanceId)}/start`, { method: 'POST' });
    assert.equal(started.status, 'running');
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    assert.ok(fs.existsSync(path.join(pluginsDir, 'package.json')), 'DSH 应通过目录联接初始化实例 profile');
    assert.ok(fs.existsSync(path.join(rootDir, 'logs', 'dsh.log')));

    const first = await fetch(started.url, { redirect: 'manual' });
    assert.equal(first.status, 303);
    const setCookie = typeof first.headers.getSetCookie === 'function'
      ? first.headers.getSetCookie()[0]
      : first.headers.get('set-cookie');
    assert.ok(setCookie, '未获得 DSH 登录 cookie');
    const cookie = setCookie.split(';')[0];
    const origin = new URL(started.url).origin;
    const ui = await fetch(`${origin}/`, { headers: { cookie } });
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /__DSH_BOOT__/);

    const logs = await api(`/api/instances/${encodeURIComponent(instanceId)}/logs?lines=50`);
    assert.match(logs.text, /已就绪/);

    const stopped = await api(`/api/instances/${encodeURIComponent(instanceId)}/stop`, { method: 'POST' });
    assert.equal(stopped.status, 'stopped');

    const sync = await api(`/api/instances/${encodeURIComponent(instanceId)}/sync-desktop`, {
      method: 'POST',
      body: { inherit: { plugins: false, credentials: true, config: true } },
    });
    assert.equal(sync.inheritance.credentials.added, 0, '重复同步不应覆盖已有 API KEY');

    const removed = await api(`/api/instances/${encodeURIComponent(instanceId)}?deleteData=1`, { method: 'DELETE' });
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.keptPaths.length > 0, true);
    assert.equal(fs.existsSync(rootDir), true, '自定义实例根目录不应被删除');
    assert.equal(fs.existsSync(workdir), true, '工作目录不应被删除');
    assert.equal(fs.existsSync(path.join(dataDir, 'instances', instanceId)), false);
  } catch (error) {
    if (instanceId) {
      const logFile = path.join(rootDir, 'logs', 'dsh.log');
      if (fs.existsSync(logFile)) {
        t.diagnostic(`--- instance log ---\n${fs.readFileSync(logFile, 'utf8')}`);
      }
    }
    t.diagnostic(`--- manager output ---\n${output}\n${stderr}`);
    throw error;
  }
});
