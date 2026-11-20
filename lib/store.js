'use strict';

const path = require('node:path');
const { ensureDir, readJson, writeJsonAtomic, randomId, slugify } = require('./util');
const { normalizeLayout } = require('./layout');

const CONFIG_VERSION = 2;

const DEFAULT_SETTINGS = {
  dshCommand: '',
  dshInstallDir: '',
  desktopHome: '',
  managerPort: 53800,
  openBrowser: true,
};

const DEFAULT_INHERIT = {
  plugins: false,
  credentials: false,
  config: false,
};

class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.configFile = path.join(this.dataDir, 'config.json');
    this.instancesDir = path.join(this.dataDir, 'instances');
    ensureDir(this.instancesDir);
    this.data = this.#load();
    if (this.needsSave) this.save();
  }

  #load() {
    const loaded = readJson(this.configFile, null);
    const data = loaded && typeof loaded === 'object' ? loaded : {};
    const instances = Array.isArray(data.instances)
      ? data.instances.filter((item) => item && typeof item.id === 'string')
      : [];
    let needsSave = Number(data.version) !== CONFIG_VERSION;
    const normalized = instances.map((instance) => {
      const layout = normalizeLayout(instance, path.join(this.instancesDir, instance.id));
      if (!instance.layout || !instance.inherit) needsSave = true;
      const next = {
        id: instance.id,
        name: typeof instance.name === 'string' && instance.name ? instance.name : instance.id,
        layout,
        port: Number.isInteger(instance.port) ? instance.port : 0,
        autoStart: Boolean(instance.autoStart),
        inherit: { ...DEFAULT_INHERIT, ...(instance.inherit || {}) },
        inheritedAt: instance.inheritedAt || null,
        createdAt: instance.createdAt || new Date().toISOString(),
        lastStartedAt: instance.lastStartedAt || null,
      };
      return next;
    });
    this.needsSave = needsSave;
    return {
      version: CONFIG_VERSION,
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
      instances: normalized,
    };
  }

  save() {
    writeJsonAtomic(this.configFile, this.data);
  }

  get settings() {
    return { ...DEFAULT_SETTINGS, ...this.data.settings };
  }

  updateSettings(patch) {
    this.data.settings = { ...this.settings, ...patch };
    this.save();
    return this.settings;
  }

  list() {
    return this.data.instances.map((instance) => structuredClone(instance));
  }

  get(id) {
    const instance = this.data.instances.find((item) => item.id === id);
    return instance ? structuredClone(instance) : null;
  }

  newId(name) {
    const ascii = slugify(name)
      .replace(/[^a-z0-9-]/g, '')
      .replace(/^-+|-+$/g, '')
      .slice(0, 16);
    const base = ascii || 'inst';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = `${base}-${randomId(4)}`;
      if (!this.get(id)) return id;
    }
    return `${base}-${randomId(8)}`;
  }

  add({ id, name, layout, port = 0, autoStart = false, inherit = DEFAULT_INHERIT, inheritedAt = null }) {
    const instance = {
      id: id || this.newId(name),
      name,
      layout: normalizeLayout({ layout }, path.join(this.instancesDir, id || 'pending')),
      port,
      autoStart: Boolean(autoStart),
      inherit: { ...DEFAULT_INHERIT, ...inherit },
      inheritedAt,
      createdAt: new Date().toISOString(),
      lastStartedAt: null,
    };
    this.data.instances.push(instance);
    this.save();
    return structuredClone(instance);
  }

  update(id, patch) {
    const instance = this.data.instances.find((item) => item.id === id);
    if (!instance) return null;
    const allowed = ['name', 'port', 'autoStart', 'lastStartedAt', 'layout', 'inherit', 'inheritedAt'];
    for (const key of allowed) {
      if (patch[key] !== undefined) instance[key] = patch[key];
    }
    if (patch.layout) instance.layout = normalizeLayout({ layout: patch.layout }, path.join(this.instancesDir, id));
    this.save();
    return structuredClone(instance);
  }

  remove(id) {
    const index = this.data.instances.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.data.instances.splice(index, 1);
    this.save();
    return true;
  }

  instanceDir(id) {
    return path.join(this.instancesDir, id);
  }

  homeDir(id) {
    const instance = this.get(id);
    return instance ? instance.layout.homeDir : path.join(this.instanceDir(id), 'home');
  }

  profileDir(id, profile = 'web') {
    const instance = this.get(id);
    const base = instance ? instance.layout.homeDir : this.homeDir(id);
    return path.join(base, 'profiles', profile);
  }

  logFile(id) {
    const instance = this.get(id);
    const dir = instance ? instance.layout.logsDir : this.instanceDir(id);
    return path.join(dir, 'dsh.log');
  }

  profilePackageFile(id, profile = 'web') {
    return path.join(this.profileDir(id, profile), 'package.json');
  }
}

module.exports = { Store, DEFAULT_SETTINGS, DEFAULT_INHERIT, CONFIG_VERSION };
