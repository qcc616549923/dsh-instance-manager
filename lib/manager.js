'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  detectDshInstall,
  commandForInstallDir,
  buildInstanceEnv,
  spawnDsh,
  runDshSync,
  killTree,
  killProcessesUnder,
  findFreePort,
  isPortFree,
} = require('./dsh');
const { inspectDesktop, applyCredentials, applyConfig, applyPlugins, repairProfileModules } = require('./desktop');
const { resolveLayout, validateLayout, ensureLayout } = require('./layout');
const {
  ensureDir,
  isDirectory,
  readJson,
  readTail,
  formatTimestamp,
  pathInside,
  samePath,
  removeTree,
} = require('./util');
const { version: VERSION } = require('../package.json');

const URL_PATTERN = /dsh web:\s+(https?:\/\/[^\s]+)/;
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 10_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const INHERIT_KEYS = ['plugins', 'credentials', 'config'];

function normalizeInherit(input, legacyCredentials = false) {
  const source = input && typeof input === 'object' ? input : {};
  const inherit = {};
  for (const key of INHERIT_KEYS) inherit[key] = Boolean(source[key]);
  if (legacyCredentials) inherit.credentials = true;
  return inherit;
}

function summarizeDesktop(desktop) {
  return {
    homeDir: desktop.homeDir,
    profileDir: desktop.profileDir,
    present: desktop.present,
    totals: desktop.totals,
    nodeModulesBytes: desktop.nodeModules.bytes,
    configEntryIds: desktop.config.entryIds,
    credentialNames: desktop.credentials.names,
  };
}

class InstanceManager {
  constructor(store, { log = console.log } = {}) {
    this.store = store;
    this.log = log;
    this.runtime = new Map();
    this.portReservations = new Map();
    this.installCache = null;
    this.installCacheAt = 0;
    for (const instance of store.list()) {
      this.#runtime(instance.id);
      if (instance.port) this.portReservations.set(instance.port, instance.id);
      try {
        const repaired = repairProfileModules(instance.layout.pluginsDir);
        if (repaired.changed) {
          this.log(`[管理器] 已修复实例「${instance.name}」从桌面复制插件的 pnpm 元数据`);
        }
      } catch (error) {
        this.log(`[管理器] 修复实例「${instance.name}」插件依赖元数据失败: ${error.message}`);
      }
    }
  }

  async #allocatePort(preferred, id, { strict = false } = {}) {
    if (Number.isInteger(preferred) && preferred > 0) {
      const owner = this.portReservations.get(preferred);
      const free = await isPortFree(preferred);
      if (free && (!owner || owner === id)) {
        this.portReservations.set(preferred, id);
        return preferred;
      }
      if (strict) {
        const error = new Error(`端口 ${preferred} 已被占用，请换一个端口或留空自动分配`);
        error.statusCode = 409;
        throw error;
      }
    }
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const port = await findFreePort(null);
      if (!this.portReservations.has(port)) {
        this.portReservations.set(port, id);
        return port;
      }
    }
    const error = new Error('无法分配空闲端口，请稍后重试');
    error.statusCode = 500;
    throw error;
  }

  #releasePort(id, port) {
    if (port && this.portReservations.get(port) === id) this.portReservations.delete(port);
  }

  #runtime(id) {
    let rt = this.runtime.get(id);
    if (!rt) {
      rt = {
        status: 'stopped',
        pid: null,
        url: null,
        token: null,
        child: null,
        startPromise: null,
        stopping: false,
        error: null,
        startedAt: null,
        logStream: null,
        buffer: '',
        startupTimer: null,
        command: '',
      };
      this.runtime.set(id, rt);
    }
    return rt;
  }

  /** Detected DSH installation + launcher, cached for a short while. */
  install({ fresh = false } = {}) {
    const now = Date.now();
    if (fresh || !this.installCache || now - this.installCacheAt > 30_000) {
      this.installCache = detectDshInstall({
        command: this.store.settings.dshCommand,
        installDir: this.store.settings.dshInstallDir,
      });
      this.installCacheAt = now;
    }
    return this.installCache;
  }

  command() {
    const detected = this.install();
    return { path: detected.command, source: detected.source };
  }

  invalidateCommand() {
    this.installCache = null;
    this.installCacheAt = 0;
  }

  desktop({ withSize = false } = {}) {
    return inspectDesktop({ home: this.store.settings.desktopHome, withSize });
  }

  #assertInstance(id) {
    const instance = this.store.get(id);
    if (!instance) {
      const error = new Error('实例不存在');
      error.statusCode = 404;
      throw error;
    }
    return instance;
  }

  #otherLayouts(excludeId = '') {
    return this.store
      .list()
      .filter((instance) => instance.id !== excludeId)
      .map((instance) => ({ name: instance.name, layout: instance.layout }));
  }

  #validateLayout(layout, excludeId = '') {
    validateLayout(layout, { dataDir: this.store.dataDir, instances: this.#otherLayouts(excludeId) });
    return layout;
  }

  #validatePort(port) {
    if (port === undefined || port === null || port === '') return null;
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      const error = new Error('端口必须是 1024–65535 之间的整数');
      error.statusCode = 400;
      throw error;
    }
    return value;
  }

  #validateName(name) {
    const clean = String(name || '').trim();
    if (!clean) {
      const error = new Error('请填写实例名称');
      error.statusCode = 400;
      throw error;
    }
    if (clean.length > 40) {
      const error = new Error('实例名称不能超过 40 个字符');
      error.statusCode = 400;
      throw error;
    }
    return clean;
  }

  #scaffoldProfile(layout, commandPath) {
    const result = runDshSync(commandPath, ['plugin', '--profile', 'web', 'list'], {
      cwd: layout.workdir,
      env: buildInstanceEnv(layout.homeDir),
      timeout: 120_000,
    });
    const manifest = path.join(layout.pluginsDir, 'package.json');
    if (result.status === 0 && fs.existsSync(manifest)) {
      return { ok: true, output: `${result.stdout || ''}`.trim() };
    }
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' ');
    return {
      ok: false,
      reason: `初始化实例 profile 失败（退出码 ${result.status ?? '超时'}）${detail ? `：${detail}` : ''}`,
    };
  }

  /**
   * Copy user-selected Desktop assets into a fresh instance: plugins (bundles +
   * node_modules), config layer, and API-key references.
   */
  #inheritDesktop(layout, inherit) {
    const report = {
      requested: { ...inherit },
      desktop: null,
      scaffold: null,
      plugins: null,
      config: null,
      credentials: null,
      warnings: [],
    };
    let desktop;
    try {
      desktop = this.desktop({ withSize: true });
    } catch (error) {
      report.warnings.push(`读取桌面配置失败：${error.message}`);
      return report;
    }
    report.desktop = summarizeDesktop(desktop);
    if (!desktop.present) {
      report.warnings.push('未找到桌面 profile（DSH Desktop 可能尚未启动过），已跳过配置复制');
      return report;
    }
    if (inherit.plugins || inherit.config) {
      const command = this.command();
      if (!command.path) {
        report.warnings.push('未找到 dsh 启动器，无法初始化实例 profile，已跳过插件/配置复制');
      } else {
        const scaffold = this.#scaffoldProfile(layout, command.path);
        report.scaffold = { ok: scaffold.ok, reason: scaffold.reason };
        if (!scaffold.ok) {
          report.warnings.push(scaffold.reason);
        } else {
          if (inherit.plugins) {
            try {
              report.plugins = applyPlugins(desktop, { profileDir: layout.pluginsDir });
              if (!report.plugins.ok) report.warnings.push(`插件未复制：${report.plugins.reason}`);
              for (const warning of report.plugins.warnings || []) report.warnings.push(warning);
            } catch (error) {
              report.plugins = { ok: false, reason: error.message };
              report.warnings.push(`插件复制失败：${error.message}`);
            }
          }
          if (inherit.config) {
            try {
              report.config = applyConfig(desktop, { profileDir: layout.pluginsDir, homeDir: layout.homeDir });
              if (!report.config.ok) report.warnings.push(`配置未复制：${report.config.reason}`);
            } catch (error) {
              report.config = { ok: false, reason: error.message };
              report.warnings.push(`配置复制失败：${error.message}`);
            }
          }
        }
      }
    }
    if (inherit.credentials) {
      try {
        report.credentials = applyCredentials(desktop, layout.homeDir);
        if (!report.credentials.ok && report.credentials.reason) report.warnings.push(`API KEY 未复制：${report.credentials.reason}`);
      } catch (error) {
        report.credentials = { ok: false, reason: error.message };
        report.warnings.push(`API KEY 复制失败：${error.message}`);
      }
    }
    return report;
  }

  async create(body = {}) {
    const name = this.#validateName(body.name);
    const id = this.store.newId(name);
    const inherit = normalizeInherit(body.inherit, Boolean(body.inheritCredentials));
    const workdir = body.workdir;
    const layout = this.#validateLayout(
      resolveLayout({
        rootDir: body.rootDir,
        defaultRoot: this.store.instanceDir(id),
        paths: body.paths && typeof body.paths === 'object' ? body.paths : {},
        workdir,
      }),
    );
    const requestedPort = this.#validatePort(body.port);
    const port = await this.#allocatePort(requestedPort, id, { strict: Boolean(requestedPort) });
    let inheritance = null;
    let layoutCreated = false;
    try {
      ensureLayout(layout);
      layoutCreated = true;
      if (inherit.plugins || inherit.config || inherit.credentials) {
        inheritance = this.#inheritDesktop(layout, inherit);
      }
    } catch (error) {
      this.#releasePort(id, port);
      if (layoutCreated && pathInside(layout.rootDir, this.store.instancesDir)) {
        removeTree(layout.rootDir);
      }
      throw error;
    }
    let instance;
    try {
      instance = this.store.add({
        id,
        name,
        layout,
        port,
        autoStart: Boolean(body.autoStart),
        inherit,
        inheritedAt: inheritance ? new Date().toISOString() : null,
      });
    } catch (error) {
      this.#releasePort(id, port);
      throw error;
    }
    this.#runtime(instance.id);
    return { ...this.describe(id), inheritance };
  }

  async update(id, patch = {}) {
    const current = this.#assertInstance(id);
    const rt = this.#runtime(id);
    const next = {};
    if (patch.name !== undefined) next.name = this.#validateName(patch.name);
    if (patch.inherit !== undefined) next.inherit = normalizeInherit(patch.inherit);
    if (patch.rootDir !== undefined || patch.paths !== undefined || patch.workdir !== undefined) {
      const layout = this.#validateLayout(
        resolveLayout({
          rootDir: patch.rootDir === undefined ? current.layout.rootDir : patch.rootDir,
          paths: {
            ...current.layout,
            ...(patch.paths && typeof patch.paths === 'object' ? patch.paths : {}),
            ...(patch.workdir !== undefined && !(patch.paths && patch.paths.workdir !== undefined)
              ? { workdir: patch.workdir }
              : {}),
          },
          workdir: patch.workdir === undefined ? current.layout.workdir : patch.workdir,
        }),
        id,
      );
      if (rt.status === 'running' || rt.status === 'starting') {
        const changed = ['rootDir', 'homeDir', 'sessionsDir', 'pluginsDir', 'workdir', 'logsDir', 'programDir'].some(
          (key) => !samePath(layout[key], current.layout[key]),
        );
        if (changed) {
          const error = new Error('实例正在运行，请先停止实例再修改目录');
          error.statusCode = 409;
          throw error;
        }
      }
      ensureLayout(layout);
      next.layout = layout;
    }
    if (patch.port !== undefined) {
      const port = this.#validatePort(patch.port);
      const allocated = await this.#allocatePort(port, id, { strict: Boolean(port) });
      if (allocated !== current.port) this.#releasePort(id, current.port);
      next.port = allocated;
    }
    if (patch.autoStart !== undefined) next.autoStart = Boolean(patch.autoStart);
    this.store.update(id, next);
    return this.describe(id);
  }

  async start(id) {
    this.#assertInstance(id);
    const rt = this.#runtime(id);
    if (rt.status === 'running') return this.describe(id);
    if (rt.startPromise) return rt.startPromise;
    rt.startPromise = this.#doStart(id)
      .catch((error) => {
        if (rt.status !== 'running') {
          rt.status = 'error';
          rt.error = error.message || String(error);
        }
        throw error;
      })
      .finally(() => {
        rt.startPromise = null;
      });
    return rt.startPromise;
  }

  #resolveCommand(layout) {
    if (layout.programDir) {
      const command = commandForInstallDir(layout.programDir);
      if (command) return { path: command, source: '实例程序目录' };
      const fallback = this.command();
      if (fallback.path) {
        return { path: fallback.path, source: `实例程序目录不可用，已回退到 ${fallback.source}` };
      }
      const error = new Error(`程序目录中没有找到 dsh 启动器：${layout.programDir}`);
      error.statusCode = 500;
      throw error;
    }
    return this.command();
  }

  async #doStart(id) {
    const instance = this.#assertInstance(id);
    const rt = this.#runtime(id);
    const layout = instance.layout;
    if (!isDirectory(layout.workdir)) {
      const error = new Error(`工作目录不存在或不是文件夹：${layout.workdir}`);
      error.statusCode = 400;
      throw error;
    }
    ensureLayout(layout);
    const command = this.#resolveCommand(layout);
    if (!command.path) {
      const error = new Error(command.source || '未找到 dsh 可执行文件，请在设置中指定');
      error.statusCode = 500;
      throw error;
    }

    const homeDir = layout.homeDir;
    const logFile = this.store.logFile(id);
    ensureDir(path.dirname(logFile));
    try {
      if (fs.statSync(logFile).size > MAX_LOG_BYTES) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      // No existing log.
    }

    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    rt.logStream = stream;
    rt.status = 'starting';
    rt.error = null;
    rt.stopping = false;
    rt.buffer = '';
    rt.url = null;
    rt.token = null;
    rt.command = command.path;
    this.#writeLog(rt, `\n===== ${formatTimestamp()} 启动实例 ${instance.name} (${id}) =====`);
    this.#writeLog(rt, `实例根目录: ${layout.rootDir}`);
    this.#writeLog(rt, `工作目录: ${layout.workdir}`);
    this.#writeLog(rt, `DSH_HOME: ${homeDir}`);
    this.#writeLog(rt, `会话目录: ${layout.sessionsDir}`);
    this.#writeLog(rt, `插件目录: ${layout.pluginsDir}`);
    this.#writeLog(rt, `命令: ${command.path}`);
    if (command.source) this.#writeLog(rt, `命令来源: ${command.source}`);
    try {
      const repaired = repairProfileModules(layout.pluginsDir);
      if (repaired.changed) {
        this.#writeLog(rt, '已修复从桌面复制插件的 pnpm 元数据（实例内可正常安装/卸载插件）');
      }
    } catch (error) {
      this.#writeLog(rt, `插件依赖元数据修复失败（实例内插件操作可能受影响）: ${error.message}`);
    }

    const owner = this.portReservations.get(instance.port);
    const usable = instance.port && (owner === undefined || owner === id) && (await isPortFree(instance.port));
    let port = instance.port;
    if (!usable) {
      port = await this.#allocatePort(null, id);
      this.#releasePort(id, instance.port);
      this.#writeLog(rt, `端口 ${instance.port} 不可用，改用 ${port}`);
      this.store.update(id, { port });
    } else if (owner === undefined) {
      this.portReservations.set(port, id);
    }

    const args = ['--profile', 'web', '--port', String(port), '--no-open'];
    const env = buildInstanceEnv(homeDir);

    let child;
    try {
      child = spawnDsh(command.path, args, { cwd: layout.workdir, env });
    } catch (error) {
      rt.status = 'error';
      rt.error = `无法启动 DSH：${error.message}`;
      this.#writeLog(rt, rt.error);
      this.#closeLog(rt);
      throw error;
    }

    rt.child = child;
    rt.pid = child.pid;
    this.#writeLog(rt, `进程 PID: ${child.pid}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      let ready = false;
      const settleReady = () => {
        if (settled) return;
        settled = true;
        ready = true;
        clearTimeout(rt.startupTimer);
        rt.startupTimer = null;
        rt.status = 'running';
        rt.startedAt = new Date().toISOString();
        this.store.update(id, { lastStartedAt: rt.startedAt });
        this.#writeLog(rt, `已就绪: ${rt.url}`);
        resolve(this.describe(id));
      };
      const settleError = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(rt.startupTimer);
        rt.startupTimer = null;
        rt.status = 'error';
        rt.error = message;
        rt.url = null;
        rt.token = null;
        this.#writeLog(rt, `启动失败: ${message}`);
        this.#closeLog(rt);
        try {
          killTree(child.pid);
        } catch {
          // Best effort.
        }
        reject(new Error(message));
      };

      const consume = (chunk, source) => {
        const text = chunk.toString('utf8');
        this.#writeLog(rt, text, source === 'stderr');
        rt.buffer = `${rt.buffer}${text}`.slice(-16_384);
        if (!ready) {
          const match = rt.buffer.match(URL_PATTERN);
          if (match) {
            rt.url = match[1].trim();
            try {
              const parsed = new URL(rt.url);
              rt.token = parsed.searchParams.get('token');
            } catch {
              rt.token = null;
            }
            settleReady();
          }
        }
      };

      child.stdout.on('data', (chunk) => consume(chunk, 'stdout'));
      child.stderr.on('data', (chunk) => consume(chunk, 'stderr'));

      child.once('error', (error) => {
        settleError(`无法启动 DSH 进程：${error.message}`);
      });

      child.once('exit', (code, signal) => {
        rt.child = null;
        rt.pid = null;
        this.#writeLog(rt, `\n[进程退出] code=${code} signal=${signal || '-'}`);
        this.#closeLog(rt);
        if (rt.stopping) {
          rt.status = 'stopped';
          rt.stopping = false;
          rt.url = null;
          rt.token = null;
          rt.error = null;
          if (!settled) {
            settled = true;
            clearTimeout(rt.startupTimer);
            rt.startupTimer = null;
            resolve(this.describe(id));
          }
          return;
        }
        if (!settled) {
          settleError(`DSH 启动过程中退出（code=${code}）`);
          return;
        }
        if (ready) {
          rt.status = 'error';
          rt.error = `DSH 进程意外退出（code=${code}）`;
          rt.url = null;
          rt.token = null;
        }
      });

      rt.startupTimer = setTimeout(() => {
        settleError('DSH 启动超时（90 秒），请查看日志');
      }, START_TIMEOUT_MS);
    });
  }

  async stop(id) {
    const instance = this.#assertInstance(id);
    const rt = this.#runtime(id);
    if (rt.startPromise) {
      try {
        await rt.startPromise;
      } catch {
        // A failed start leaves nothing to stop.
      }
    }
    if (!rt.child && !rt.pid) {
      rt.status = 'stopped';
      rt.url = null;
      rt.token = null;
      rt.error = null;
      return this.describe(id);
    }
    rt.stopping = true;
    rt.status = 'stopping';
    this.#writeLog(rt, `\n===== ${formatTimestamp()} 停止实例 =====`);
    const child = rt.child;
    const pid = rt.pid;
    const exited = new Promise((resolve) => {
      if (!child) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, STOP_TIMEOUT_MS);
    });
    const result = killTree(pid);
    if (result && result.output) this.#writeLog(rt, result.output);
    if (result && !result.ok) {
      this.#writeLog(rt, `taskkill 失败：${result.reason || result.output || '未知错误'}`);
      try {
        child?.kill('SIGKILL');
      } catch {
        // Ignore.
      }
    }
    await exited;
    try {
      const hasPlugins = isDirectory(path.join(instance.layout.pluginsDir, 'node_modules'));
      if (hasPlugins) {
        const cleanup = killProcessesUnder([instance.layout.pluginsDir, instance.layout.homeDir]);
        if (cleanup.pids.length) this.#writeLog(rt, `已清理实例目录中的残留进程: ${cleanup.pids.join(', ')}`);
      }
    } catch {
      // Best effort; a locked helper should not block the instance from stopping.
    }
    rt.stopping = false;
    rt.child = null;
    rt.pid = null;
    rt.status = 'stopped';
    rt.url = null;
    rt.token = null;
    rt.error = null;
    this.#closeLog(rt);
    return this.describe(id);
  }

  async restart(id) {
    await this.stop(id);
    return this.start(id);
  }

  async remove(id, { deleteData = true } = {}) {
    const instance = this.#assertInstance(id);
    await this.stop(id);
    this.store.remove(id);
    this.runtime.delete(id);
    this.#releasePort(id, instance.port);
    const result = { ok: true, deletedRoot: null, keptPaths: [] };
    if (!deleteData) {
      result.keptPaths = [instance.layout.rootDir];
      return result;
    }
    const root = path.resolve(instance.layout.rootDir);
    const instanceDir = this.store.instanceDir(id);
    if (pathInside(root, this.store.instancesDir)) {
      removeTree(root);
      result.deletedRoot = root;
      return result;
    }
    // A user-chosen root is never deleted. Only remove the manager's own record
    // directory, and only when no live layout directory lives inside it.
    const layoutDirs = [
      instance.layout.homeDir,
      instance.layout.sessionsDir,
      instance.layout.pluginsDir,
      instance.layout.workdir,
      instance.layout.logsDir,
    ];
    const containsLayout = layoutDirs.some((dir) => pathInside(dir, instanceDir));
    if (!containsLayout && fs.existsSync(instanceDir)) {
      removeTree(instanceDir);
    }
    result.keptPaths = [root, instance.layout.homeDir, instance.layout.workdir];
    return result;
  }

  #closeLog(rt) {
    if (rt.logStream) {
      try {
        rt.logStream.end();
      } catch {
        // Ignore.
      }
      rt.logStream = null;
    }
  }

  #writeLog(rt, text, isError = false) {
    if (!text) return;
    const stream = isError ? process.stderr : process.stdout;
    if (!rt.logStream) {
      stream.write(text.endsWith('\n') ? text : `${text}\n`);
      return;
    }
    const value = text.endsWith('\n') ? text : `${text}\n`;
    rt.logStream.write(value);
  }

  /** Re-copy Desktop assets into an existing (stopped) instance. */
  async syncDesktop(id, options = {}) {
    const instance = this.#assertInstance(id);
    const rt = this.#runtime(id);
    if (rt.status === 'running' || rt.status === 'starting') {
      const error = new Error('请先停止实例，再同步桌面配置');
      error.statusCode = 409;
      throw error;
    }
    const provided =
      options.inherit && typeof options.inherit === 'object'
        ? options.inherit
        : INHERIT_KEYS.some((key) => key in options)
          ? options
          : null;
    const inherit = provided ? { ...instance.inherit, ...normalizeInherit(provided) } : { ...instance.inherit };
    ensureLayout(instance.layout);
    const inheritance = this.#inheritDesktop(instance.layout, inherit);
    this.store.update(id, { inherit, inheritedAt: new Date().toISOString() });
    return { ...this.describe(id), inheritance };
  }

  describe(id) {
    const instance = this.#assertInstance(id);
    const rt = this.#runtime(id);
    const layout = instance.layout;
    let pluginCount = 0;
    try {
      const pkg = readJson(path.join(layout.pluginsDir, 'package.json'), null);
      pluginCount = Object.keys(pkg?.dependencies || {}).length;
    } catch {
      pluginCount = 0;
    }
    const programCommand = layout.programDir ? commandForInstallDir(layout.programDir) : '';
    return {
      ...instance,
      layout,
      status: rt.status,
      pid: rt.pid,
      url: rt.url,
      error: rt.error,
      startedAt: rt.startedAt,
      command: rt.command || programCommand || this.command().path,
      rootDir: layout.rootDir,
      homeDir: layout.homeDir,
      sessionsDir: layout.sessionsDir,
      pluginsDir: layout.pluginsDir,
      profileDir: layout.pluginsDir,
      workdir: layout.workdir,
      logsDir: layout.logsDir,
      programDir: layout.programDir,
      logFile: this.store.logFile(id),
      pluginCount,
      profile: 'web',
    };
  }

  list() {
    return this.store.list().map((instance) => this.describe(instance.id));
  }

  state(extra = {}) {
    const install = this.install();
    let desktop = null;
    try {
      const info = this.desktop();
      desktop = {
        homeDir: info.homeDir,
        profileDir: info.profileDir,
        present: info.present,
        totals: info.totals,
      };
    } catch (error) {
      desktop = { error: error.message };
    }
    return {
      manager: {
        ...extra,
        dshCommand: install.command,
        dshInstallDir: install.installDir,
        dshCommandSource: install.source,
        desktop,
        version: VERSION,
      },
      instances: this.list(),
    };
  }

  logs(id, lines = 200) {
    this.#assertInstance(id);
    return readTail(this.store.logFile(id), Math.max(10, Math.min(2000, Number(lines) || 200)));
  }

  #instanceCommand(instance) {
    if (instance.layout.programDir) {
      return commandForInstallDir(instance.layout.programDir) || this.command().path;
    }
    return this.command().path;
  }

  profileInfo(id) {
    const instance = this.#assertInstance(id);
    const layout = instance.layout;
    let dependencies = [];
    try {
      const pkg = readJson(path.join(layout.pluginsDir, 'package.json'), null);
      dependencies = Object.keys(pkg?.dependencies || {}).sort();
    } catch {
      dependencies = [];
    }
    const command = this.#instanceCommand(instance);
    const home = layout.homeDir;
    return {
      homeDir: home,
      sessionsDir: layout.sessionsDir,
      pluginsDir: layout.pluginsDir,
      profileDir: layout.pluginsDir,
      programDir: layout.programDir,
      workdir: layout.workdir,
      logsDir: layout.logsDir,
      packageFile: path.join(layout.pluginsDir, 'package.json'),
      dependencies,
      inherit: instance.inherit,
      inheritedAt: instance.inheritedAt,
      installCommand: `set DSH_HOME=${home}\r\n"${command || 'dsh.cmd'}" plugin --profile web add <包名>`,
      listCommand: `set DSH_HOME=${home}\r\n"${command || 'dsh.cmd'}" plugin --profile web list`,
    };
  }

  async openPath(id, kind) {
    const instance = this.#assertInstance(id);
    const layout = instance.layout;
    const targets = {
      workdir: layout.workdir,
      home: layout.homeDir,
      sessions: layout.sessionsDir,
      plugins: layout.pluginsDir,
      profile: layout.pluginsDir,
      logs: layout.logsDir,
      root: layout.rootDir,
      data: this.store.instanceDir(id),
      program: layout.programDir,
    };
    const target = targets[kind];
    if (!target) {
      const error = new Error('未知的目录类型');
      error.statusCode = 400;
      throw error;
    }
    if (kind === 'workdir' || kind === 'program') {
      if (!isDirectory(target)) {
        const error = new Error(`目录不存在：${target}`);
        error.statusCode = 404;
        throw error;
      }
    } else {
      ensureDir(target);
    }
    if (process.platform === 'win32') {
      const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(command, [target], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return { ok: true, path: target };
  }

  async stopAll() {
    const running = [...this.runtime.entries()].filter(([, rt]) => rt.child || rt.pid);
    for (const [id] of running) {
      try {
        await this.stop(id);
      } catch (error) {
        this.log(`停止实例 ${id} 失败: ${error.message}`);
      }
    }
  }

  async autoStartAll() {
    for (const instance of this.store.list()) {
      if (!instance.autoStart) continue;
      this.start(instance.id).catch((error) => {
        this.log(`自动启动 ${instance.name} 失败: ${error.message}`);
      });
    }
  }
}

module.exports = { InstanceManager, normalizeInherit };
