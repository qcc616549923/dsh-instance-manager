'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { inspectDesktop, applyCredentials, applyConfig, applyPlugins, readCredentialRefs, patchEntryIds } = require('../lib/desktop');
const { resolveLayout, validateLayout, ensureLayout, defaultLayout } = require('../lib/layout');
const { detectDshInstall, commandForInstallDir, resolveInstallDir } = require('../lib/dsh');
const { Store } = require('../lib/store');
const { copyTree, removeTree } = require('../lib/util');

function tempDir(label) {
  const dir = path.join(os.tmpdir(), `dshm-test-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeDesktopFixture() {
  const home = tempDir('desktop');
  write(
    path.join(home, '.credentials.yaml'),
    [
      'version: 1',
      'records:',
      '  client-connection/browser-session:',
      '    kind: browser-session',
      '    payload:',
      '      version: 1',
      '      secret: super-secret-record',
      'refs:',
      '  OPENCODE_GO_API_KEY: sk-test-one',
      '  OTHER_API_KEY: sk-test-two',
      '',
    ].join('\n'),
  );
  write(
    path.join(home, 'profiles', 'desktop', 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: { 'dsh-ops': '^0.5.2', 'dsh-whale-widget': '^0.4.2' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-ops', 'dsh-whale-widget'] } },
      },
      null,
      2,
    ),
  );
  write(
    path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
    '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers: {}\n- id: permission\n  name: "@deepseek-ai/dsh-permission-presets"\n',
  );
  write(path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-ops', 'package.json'), '{"name":"dsh-ops"}');
  write(path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-ops', 'index.js'), 'module.exports = {};');
  write(path.join(home, 'profiles', 'desktop', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  return home;
}

test('desktop inspection reports plugins, config and API-key names without values', () => {
  const home = makeDesktopFixture();
  try {
    const info = inspectDesktop({ home, withSize: false });
    assert.equal(info.present, true);
    assert.deepEqual(
      info.plugins.map((plugin) => plugin.name).sort(),
      ['dsh-ops', 'dsh-whale-widget'],
    );
    assert.equal(info.bundles.length, 4);
    assert.deepEqual(info.credentials.names.sort(), ['OPENCODE_GO_API_KEY', 'OTHER_API_KEY']);
    assert.deepEqual(info.config.entryIds, ['llm-pi-ai', 'permission']);
    assert.equal(info.config.hasContent, true);
    assert.equal(info.totals.credentials, 2);
    assert.equal(JSON.stringify(info).includes('sk-test-one'), false, '凭据值不应出现在检查结果中');
    assert.equal(JSON.stringify(info).includes('super-secret-record'), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('desktop assets copy into an instance profile (plugins, config, API keys only)', () => {
  const home = makeDesktopFixture();
  const instance = tempDir('instance');
  try {
    const desktop = inspectDesktop({ home, withSize: false });
    const profileDir = path.join(instance, 'home', 'profiles', 'web');
    write(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: {}, dsh: { profile: { bundles: [] } } }));
    write(path.join(profileDir, 'cordis.patch.yml'), '[]\n');

    const plugins = applyPlugins(desktop, { profileDir });
    assert.equal(plugins.ok, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles.slice(0, 2), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
    assert.equal(manifest.dependencies['dsh-ops'], '^0.5.2');
    assert.equal(fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-ops', 'index.js')), true);
    assert.equal(fs.existsSync(path.join(profileDir, 'pnpm-lock.yaml')), true);

    const config = applyConfig(desktop, { profileDir, homeDir: path.join(instance, 'home') });
    assert.equal(config.ok, true);
    assert.match(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), /llm-pi-ai/);

    const credentials = applyCredentials(desktop, path.join(instance, 'home'));
    assert.equal(credentials.added, 2);
    const credentialsText = fs.readFileSync(path.join(instance, 'home', '.credentials.yaml'), 'utf8');
    assert.match(credentialsText, /OPENCODE_GO_API_KEY: sk-test-one/);
    assert.equal(credentialsText.includes('records:'), false, '不应复制桌面登录会话记录');

    const again = applyCredentials(desktop, path.join(instance, 'home'));
    assert.equal(again.added, 0, '重复同步不应覆盖已有 API KEY');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(instance, { recursive: true, force: true });
  }
});

test('credentials parser tolerates missing refs and inline empty maps', () => {
  assert.deepEqual(readCredentialRefs(path.join(tempDir('missing'), 'none.yaml')).names, []);
  const file = path.join(tempDir('inline'), '.credentials.yaml');
  write(file, 'version: 1\nrefs: {}\n');
  assert.deepEqual(readCredentialRefs(file).names, []);
  assert.deepEqual(patchEntryIds('- id: a\n  name: x\n- id: b\n'), ['a', 'b']);
});

test('API-key sync preserves the instance login records and existing keys', () => {
  const home = makeDesktopFixture();
  const instanceHome = tempDir('cred-instance');
  try {
    const target = path.join(instanceHome, '.credentials.yaml');
    write(
      target,
      ['version: 1', 'refs:', '  OTHER_API_KEY: instance-own', 'records:', '  client-connection/browser-session:', '    kind: browser-session', '    payload:', '      secret: instance-secret', ''].join('\n'),
    );
    const desktop = inspectDesktop({ home, withSize: false });
    const result = applyCredentials(desktop, instanceHome);
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    const text = fs.readFileSync(target, 'utf8');
    assert.match(text, /OPENCODE_GO_API_KEY: sk-test-one/);
    assert.match(text, /OTHER_API_KEY: instance-own/, '已有 KEY 不应被覆盖');
    assert.match(text, /secret: instance-secret/, '实例自己的登录会话记录必须保留');
    assert.match(text, /^records:/m);
    assert.equal(readCredentialRefs(target).names.length, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(instanceHome, { recursive: true, force: true });
  }
});

test('directory plan generates subdirectories and wires junctions', () => {
  const root = tempDir('layout');
  try {
    const layout = resolveLayout({
      rootDir: root,
      paths: { sessionsDir: path.join(root, 'sessions-custom'), pluginsDir: path.join(root, 'plugins-custom') },
    });
    assert.equal(layout.homeDir, path.join(root, 'home'));
    assert.equal(layout.workdir, path.join(root, 'work'));
    assert.equal(layout.logsDir, path.join(root, 'logs'));
    validateLayout(layout, { dataDir: path.join(root, 'data') });
    ensureLayout(layout);
    for (const dir of [layout.homeDir, layout.sessionsDir, layout.pluginsDir, layout.workdir, layout.logsDir]) {
      assert.equal(fs.statSync(dir).isDirectory(), true, `${dir} 应存在`);
    }
    const sessionsLink = path.join(layout.homeDir, 'sessions');
    const pluginsLink = path.join(layout.homeDir, 'profiles', 'web');
    assert.equal(fs.lstatSync(sessionsLink).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(pluginsLink).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(sessionsLink).toLowerCase(), layout.sessionsDir.toLowerCase());
    assert.equal(fs.realpathSync(pluginsLink).toLowerCase(), layout.pluginsDir.toLowerCase());

    const defaults = defaultLayout(root);
    assert.equal(defaults.sessionsDir, path.join(root, 'home', 'sessions'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('directory plan rejects drive roots and overlapping instances', () => {
  assert.throws(() => validateLayout(resolveLayout({ rootDir: 'C:\\' }), {}), /磁盘根目录/);
  const rootA = path.join(os.tmpdir(), `dshm-a-${Date.now()}`);
  const rootB = path.join(rootA, 'nested');
  const layoutA = resolveLayout({ rootDir: rootA });
  const layoutB = resolveLayout({ rootDir: rootB });
  assert.throws(() => validateLayout(layoutB, { instances: [{ name: 'A', layout: layoutA }] }), /重叠/);
});

test('plugin payload copies are independent and removable', () => {
  const source = tempDir('copy-src');
  const destination = tempDir('copy-dst');
  try {
    write(path.join(source, 'pkg', 'index.js'), 'module.exports = 1;');
    write(path.join(source, 'pkg', 'assets', 'logo.txt'), 'logo');
    fs.chmodSync(path.join(source, 'pkg', 'assets', 'logo.txt'), 0o444);
    copyTree(path.join(source, 'pkg'), path.join(destination, 'pkg'));
    assert.equal(fs.readFileSync(path.join(destination, 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;');
    assert.equal(fs.readFileSync(path.join(destination, 'pkg', 'assets', 'logo.txt'), 'utf8'), 'logo');
    assert.ok((fs.statSync(path.join(destination, 'pkg', 'assets', 'logo.txt')).mode & 0o200) !== 0, '复制后的只读文件应可删除');
    fs.chmodSync(path.join(destination, 'pkg', 'index.js'), 0o444);
    removeTree(path.join(destination, 'pkg'));
    assert.equal(fs.existsSync(path.join(destination, 'pkg')), false);
    assert.equal(fs.existsSync(path.join(source, 'pkg', 'index.js')), true, '源目录必须保持不变');
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test('v1 config migrates to the directory plan without losing the workdir', () => {
  const dataDir = tempDir('store');
  try {
    write(
      path.join(dataDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: { dshCommand: '' },
          instances: [
            {
              id: 'legacy-1',
              name: 'legacy',
              workdir: path.join(dataDir, 'work'),
              port: 54600,
              autoStart: true,
              createdAt: '2026-01-01T00:00:00.000Z',
              lastStartedAt: null,
            },
          ],
        },
        null,
        2,
      ),
    );
    const store = new Store(dataDir);
    const instance = store.get('legacy-1');
    assert.equal(instance.layout.rootDir, path.join(dataDir, 'instances', 'legacy-1'));
    assert.equal(instance.layout.homeDir, path.join(dataDir, 'instances', 'legacy-1', 'home'));
    assert.equal(instance.layout.workdir, path.join(dataDir, 'work'));
    assert.deepEqual(instance.inherit, { plugins: false, credentials: false, config: false });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(saved.version, 2);
    assert.ok(saved.instances[0].layout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('DSH install detection resolves a launcher from an install directory', () => {
  const installRoot = tempDir('install');
  try {
    const commandFile = path.join(installRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    write(commandFile, '@echo off\n');
    assert.equal(commandForInstallDir(installRoot), commandFile);
    const detected = detectDshInstall({ installDir: installRoot, useShortcuts: false });
    assert.equal(detected.installDir, installRoot);
    assert.equal(detected.command, commandFile);
    assert.equal(resolveInstallDir(commandFile), installRoot, '从 dsh.cmd 路径应还原安装根目录');
    assert.equal(resolveInstallDir(path.join(installRoot, 'resources')), installRoot, 'resources 不是安装根目录');
    const fromCommand = detectDshInstall({ command: commandFile, useShortcuts: false });
    assert.equal(fromCommand.installDir, installRoot);
  } finally {
    fs.rmSync(installRoot, { recursive: true, force: true });
  }
});
