'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { Store } = require('../lib/store');
const { resolveLayout } = require('../lib/layout');
const {
  buildManagerExport,
  importManagerConfig,
  exportInstanceArchive,
  importInstanceArchive,
} = require('../lib/transfer');
const { listZip } = require('../lib/zip');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const created = [];

function tempDir(label) {
  const dir = path.join(__dirname, '.tmp', `transfer-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Keep host-level pnpm store config from changing the expected store in tests. */
function withoutStoreConfig(fn) {
  const previous = process.env.npm_config_store_dir;
  process.env.npm_config_store_dir = 'Z:\\dshm-test-store';
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.npm_config_store_dir;
    else process.env.npm_config_store_dir = previous;
  }
}

function makeFakeInstance(baseDir) {
  const root = path.join(baseDir, 'instance');
  const layout = resolveLayout({ rootDir: root });
  write(path.join(layout.homeDir, '.credentials.yaml'), 'version: 1\nrefs:\n  TEST_API_KEY: sk-test\n');
  write(path.join(layout.homeDir, 'cordis.patch.yml'), '- id: demo\n');
  write(path.join(layout.pluginsDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: { 'dsh-ops': '0.5.5' } }));
  write(
    path.join(layout.pluginsDir, 'node_modules', '.modules.yaml'),
    JSON.stringify({
      nodeLinker: 'hoisted',
      packageManager: 'pnpm@11.28.5',
      storeDir: 'Z:\\pnpm\\store\\v11',
      virtualStoreDir: path.join(layout.pluginsDir, 'node_modules', '.pnpm'),
    }),
  );
  write(path.join(layout.pluginsDir, 'node_modules', 'dsh-ops', 'index.js'), 'module.exports = 1;\n');
  write(path.join(layout.sessionsDir, 'session-1', 'session.json'), '{"id":"session-1"}\n');
  write(path.join(layout.homeDir, 'storages', 'workspace.json'), '{"cwd":"demo"}\n');
  write(path.join(layout.logsDir, 'dsh.log'), 'started\n');
  write(path.join(layout.workdir, 'project', 'readme.md'), '# demo\n');
  return {
    instance: { id: 'demo-1', name: 'demo', layout, autoStart: false, inherit: { plugins: false, credentials: false, config: false }, inheritedAt: null },
    layout,
  };
}

test('manager configuration exports without secrets and imports into another manager', () => {
  const sourceDir = tempDir('cfg-source');
  const targetDir = tempDir('cfg-target');
  const source = new Store(sourceDir);
  const target = new Store(targetDir);
  const layout = resolveLayout({ rootDir: path.join(sourceDir, 'instances', 'alpha') });
  source.add({ id: 'alpha-1', name: 'alpha', layout, port: 54011, autoStart: true, inherit: { plugins: true, credentials: true, config: false } });

  const payload = buildManagerExport(source, { managerVersion: '1.1.0' });
  assert.equal(payload.kind, 'dshm-manager-config');
  assert.equal(payload.instances.length, 1);
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('token'), false, '导出内容不应包含令牌');
  assert.equal(serialized.includes('sk-'), false, '导出内容不应包含 API KEY');

  const result = importManagerConfig(target, payload, { mode: 'merge', applySettings: true });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].name, 'alpha');
  const imported = target.get('alpha-1');
  assert.equal(imported.name, 'alpha');
  assert.equal(imported.port, 54011);
  assert.equal(imported.autoStart, true);
  assert.deepEqual(imported.inherit, { plugins: true, credentials: true, config: false });
  assert.equal(imported.layout.rootDir, path.resolve(layout.rootDir));
  assert.match(result.warnings.join(' '), /目录尚未就位/);

  const again = importManagerConfig(target, payload, { mode: 'merge', applySettings: false });
  assert.equal(again.imported.length, 0);
  assert.equal(again.skipped.length, 1);
  assert.equal(target.list().length, 1);

  const replaced = importManagerConfig(target, { ...payload, instances: [{ ...payload.instances[0], name: 'beta' }] }, { mode: 'replace' });
  assert.equal(replaced.imported.length, 1);
  assert.equal(target.list().length, 1);
  assert.equal(target.list()[0].name, 'beta');
});

test('manager configuration import rejects unrelated JSON and conflicting plans', () => {
  const store = new Store(tempDir('cfg-bad'));
  assert.throws(() => importManagerConfig(store, { hello: 'world' }), /实例列表/);
  assert.throws(() => importManagerConfig(store, 'not json'), /合法的 JSON/);
  assert.throws(() => importManagerConfig(store, { kind: 'other' }), /kind/);

  const base = tempDir('cfg-conflict');
  const first = resolveLayout({ rootDir: path.join(base, 'a') });
  store.add({ name: 'one', layout: first, port: 0 });
  const payload = {
    kind: 'dshm-manager-config',
    version: 1,
    settings: {},
    instances: [{ id: 'two', name: 'two', layout: resolveLayout({ rootDir: path.join(base, 'a', 'home', 'nested') }), port: 0 }],
  };
  const result = importManagerConfig(store, payload, { applySettings: false });
  assert.equal(result.imported.length, 0);
  assert.match(result.skipped[0].reason, /重叠/);

  const portPayload = {
    kind: 'dshm-manager-config',
    version: 1,
    instances: [{ id: 'three', name: 'three', layout: resolveLayout({ rootDir: path.join(base, 'c') }), port: first.port || 54099 }],
  };
  const portResult = importManagerConfig(store, portPayload, { applySettings: false });
  assert.equal(portResult.imported.length, 1);
});

test('instance archive round trip restores home, profile, logs and work data', async () => {
  const work = tempDir('inst-export');
  const { instance, layout } = makeFakeInstance(work);
  const zipFile = path.join(work, 'demo.zip');
  const exported = await exportInstanceArchive({ instance, destFile: zipFile, managerVersion: '1.1.0', options: { modules: true, logs: true, work: true, credentials: true } });
  assert.equal(exported.files >= 8, true);
  assert.ok(fs.statSync(zipFile).size > 0);

  const names = (await listZip(zipFile)).map((entry) => entry.name);
  for (const expected of [
    'dshm-instance.json',
    'home/.credentials.yaml',
    'home/cordis.patch.yml',
    'home/profiles/web/node_modules/dsh-ops/index.js',
    'home/storages/workspace.json',
    'logs/dsh.log',
    'work/project/readme.md',
  ]) {
    assert.ok(names.includes(expected), `归档缺少 ${expected}`);
  }

  const targetDir = tempDir('inst-import');
  const store = new Store(targetDir);
  const newRoot = path.join(targetDir, 'copied');
  const result = await withoutStoreConfig(() => importInstanceArchive({ store, zipFile, name: 'imported', rootDir: newRoot }));
  assert.equal(result.instance.name, 'imported');
  const imported = store.get(result.instance.id);
  assert.equal(imported.layout.rootDir, path.resolve(newRoot));
  assert.ok(fs.existsSync(path.join(newRoot, 'home', 'cordis.patch.yml')));
  assert.ok(fs.existsSync(path.join(newRoot, 'home', 'storages', 'workspace.json')));
  assert.ok(fs.existsSync(path.join(newRoot, 'home', 'profiles', 'web', 'node_modules', 'dsh-ops', 'index.js')));
  assert.ok(fs.existsSync(path.join(newRoot, 'logs', 'dsh.log')));
  assert.ok(fs.existsSync(path.join(newRoot, 'work', 'project', 'readme.md')));
  assert.equal(fs.existsSync(path.join(newRoot, '.dshm-import')), false, '导入后应清理临时目录');

  const metadata = JSON.parse(fs.readFileSync(path.join(newRoot, 'home', 'profiles', 'web', 'node_modules', '.modules.yaml'), 'utf8'));
  const volumeRoot = path.parse(path.resolve(newRoot)).root;
  assert.equal(metadata.storeDir, path.join(volumeRoot, '.pnpm-store', 'v11'), '导入时应把跨盘 store 改到实例所在盘');
  assert.equal(metadata.virtualStoreDir, path.join(newRoot, 'home', 'profiles', 'web', 'node_modules', '.pnpm'));

  assert.equal(exported.manifest.instance.id, 'demo-1');
  assert.equal(imported.layout.workdir, path.join(newRoot, 'work'));
});

test('instance archive can skip credentials and modules', async () => {
  const work = tempDir('inst-skip');
  const { instance } = makeFakeInstance(work);
  const zipFile = path.join(work, 'lean.zip');
  await exportInstanceArchive({ instance, destFile: zipFile, options: { modules: false, logs: false, work: false, credentials: false } });
  const names = (await listZip(zipFile)).map((entry) => entry.name);
  assert.equal(names.some((name) => name.endsWith('.credentials.yaml')), false);
  assert.equal(names.some((name) => name.includes('node_modules')), false);
  assert.equal(names.some((name) => name.startsWith('logs/')), false);
  assert.ok(names.includes('home/cordis.patch.yml'));

  const targetDir = tempDir('inst-skip-target');
  const store = new Store(targetDir);
  const result = await importInstanceArchive({ store, zipFile });
  assert.equal(result.instance.name, 'demo');
  assert.equal(fs.existsSync(path.join(result.instance.layout.homeDir, '.credentials.yaml')), false);
});

test('instance import rejects archives without a manifest', async () => {
  const work = tempDir('inst-bad');
  const { writeZip } = require('../lib/zip');
  const zipFile = path.join(work, 'bad.zip');
  await writeZip(zipFile, [{ name: 'home/readme.txt', data: 'hi' }]);
  const store = new Store(tempDir('inst-bad-target'));
  await assert.rejects(() => importInstanceArchive({ store, zipFile }), /缺少 dshm-instance.json/);
});

test('HTTP export/import endpoints round trip a real instance', { timeout: 120_000 }, async (t) => {
  const temp = path.join(__dirname, '.tmp', `transfer-http-${Date.now()}`);
  const dataDir = path.join(temp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
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
  const url = (pathname) => new URL(pathname, baseUrl);
  const headers = () => ({ 'x-dshm-token': token });
  const api = async (pathname, options = {}) => {
    const requestHeaders = { ...headers(), ...(options.headers || {}) };
    let body = options.body;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      requestHeaders['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await fetch(url(pathname), { ...options, headers: requestHeaders, body });
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
        // Already shutting down.
      }
    }
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(12_000)]);
    if (server.exitCode === null && process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true });
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const match = output.match(/管理界面: (http:\/\/127\.0\.0\.1:\d+\/)/);
    if (match) {
      baseUrl = match[1];
      break;
    }
    await sleep(200);
  }
  assert.ok(baseUrl, `管理器未启动：\n${output}\n${stderr}`);
  const html = await (await fetch(baseUrl)).text();
  token = html.match(/name="dshm-token" content="([^"]+)"/)[1];

  const rootDir = path.join(temp, 'original');
  const instance = await api('/api/instances', {
    method: 'POST',
    body: { name: 'http-demo', rootDir, inherit: { plugins: false, credentials: false, config: false } },
  });
  write(path.join(instance.homeDir, 'cordis.patch.yml'), '- id: http\n');
  write(path.join(instance.homeDir, 'storages', 'workspace.json'), '{"k":1}\n');

  const configResponse = await fetch(url('/api/config/export'), { headers: headers() });
  assert.equal(configResponse.status, 200);
  assert.match(configResponse.headers.get('content-disposition') || '', /attachment; filename=/);
  const config = await configResponse.json();
  assert.equal(config.kind, 'dshm-manager-config');
  assert.equal(config.instances.length, 1);

  const mergeResult = await api('/api/config/import', {
    method: 'POST',
    body: { config, mode: 'merge', applySettings: false },
  });
  assert.equal(mergeResult.imported.length, 0);
  assert.equal(mergeResult.skipped.length, 1);

  const exportResponse = await fetch(url(`/api/instances/${encodeURIComponent(instance.id)}/export?modules=0&logs=1&work=0`), { headers: headers() });
  assert.equal(exportResponse.status, 200);
  const zipBuffer = Buffer.from(await exportResponse.arrayBuffer());
  assert.ok(zipBuffer.length > 0);
  const zipFile = path.join(temp, 'downloaded.zip');
  fs.writeFileSync(zipFile, zipBuffer);
  const names = (await listZip(zipFile)).map((entry) => entry.name);
  assert.ok(names.includes('dshm-instance.json'));
  assert.ok(names.includes('home/cordis.patch.yml'));

  const importResponse = await fetch(url('/api/instances/import?name=copy'), {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/zip' },
    body: zipBuffer,
  });
  assert.equal(importResponse.status, 201);
  const imported = await importResponse.json();
  assert.equal(imported.instance.name, 'copy');
  assert.equal(imported.instance.status, 'stopped');
  assert.ok(fs.existsSync(path.join(imported.instance.homeDir, 'cordis.patch.yml')));
  assert.ok(fs.existsSync(path.join(imported.instance.homeDir, 'storages', 'workspace.json')));

  const state = await api('/api/state');
  assert.equal(state.instances.length, 2);
});
