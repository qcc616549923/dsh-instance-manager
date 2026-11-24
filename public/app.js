'use strict';

const TOKEN = document.querySelector('meta[name="dshm-token"]').content;
const VERSION = document.querySelector('meta[name="dshm-version"]').content;
const $ = (id) => document.getElementById(id);

const DIR_FIELDS = [
  { key: 'programDir', input: 'field-program' },
  { key: 'homeDir', input: 'field-home' },
  { key: 'sessionsDir', input: 'field-sessions' },
  { key: 'pluginsDir', input: 'field-plugins' },
  { key: 'workdir', input: 'field-workdir' },
  { key: 'logsDir', input: 'field-logs' },
];

const state = {
  instances: [],
  manager: {},
  search: '',
  busy: new Set(),
  editingId: null,
  rootTouched: false,
  dirTouched: new Set(),
  picker: { path: '', current: '', target: null, title: '选择工作目录' },
  logsId: null,
  logsTimer: null,
  profileId: null,
  deleteId: null,
  settings: null,
  desktop: null,
  desktopInstall: null,
  offline: false,
  exportId: null,
  configImport: null,
};

const STATUS = {
  stopped: { label: '已停止', className: 'stopped' },
  starting: { label: '启动中', className: 'starting' },
  running: { label: '运行中', className: 'running' },
  stopping: { label: '停止中', className: 'stopping' },
  error: { label: '异常', className: 'error' },
};

const ICON = {
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 5.5v13l11-6.5-11-6.5Z" stroke-linejoin="round"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 4h6v6M20 4l-9 9" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" stroke-linecap="round"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" stroke-linejoin="round"/><path d="m13.5 7.5 3 3" stroke-linecap="round"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V5h6v2M6.5 7l.8 12.2A1.8 1.8 0 0 0 9.1 21h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11v6M14 11v6" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01" stroke-linecap="round"/></svg>',
  plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5V8ZM12 16v5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.6 2.6L16 9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16h.01" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18" stroke-linecap="round"/></svg>',
  sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h11a4 4 0 0 1 4 4v1M20 17H9a4 4 0 0 1-4-4v-1" stroke-linecap="round"/><path d="m17 4 3 3-3 3M7 20l-3-3 3-3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 4v11m0 0 4-4m-4 4-4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke-linecap="round"/></svg>',
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function attr(value) {
  return esc(value);
}

function joinPath(base, ...parts) {
  if (!base) return '';
  const separator = base.includes('\\') ? '\\' : '/';
  let result = base.replace(/[\\/]+$/, '');
  for (const part of parts) {
    const clean = String(part).replace(/^[\\/]+|[\\/]+$/g, '');
    if (clean) result += `${separator}${clean}`;
  }
  return result;
}

function baseName(target) {
  if (!target) return '';
  const parts = String(target).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || target;
}

function randomSuffix() {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function slugifyName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

function statusOf(instance) {
  return STATUS[instance.status] || STATUS.stopped;
}

function initialOf(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return 'D';
  return Array.from(trimmed)[0];
}

async function api(path, options = {}) {
  const headers = { 'x-dshm-token': TOKEN, ...(options.headers || {}) };
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data && data.error ? data.error : `请求失败（HTTP ${response.status}）`);
  }
  return data;
}

function toast(message, kind = 'info', timeout = 4500) {
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  const icon = kind === 'success' ? ICON.success : kind === 'error' ? ICON.error : ICON.info;
  item.innerHTML = `<span class="toast-icon">${icon}</span><span>${esc(message)}</span>`;
  $('toasts').appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(6px)';
    item.style.transition = 'opacity 160ms ease, transform 160ms ease';
    setTimeout(() => item.remove(), 180);
  }, timeout);
}

function timeAgo(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function chip(label, value, icon = '', extra = '') {
  return `<span class="chip ${extra}">${icon}${esc(label)}${value !== undefined ? ` <strong>${esc(value)}</strong>` : ''}</span>`;
}

function inheritSummary(instance) {
  const inherit = instance.inherit || {};
  const labels = [];
  if (inherit.plugins) labels.push('插件');
  if (inherit.credentials) labels.push('API KEY');
  if (inherit.config) labels.push('配置');
  return labels;
}

function cardHtml(instance) {
  const status = statusOf(instance);
  const running = instance.status === 'running';
  const starting = instance.status === 'starting';
  const stopping = instance.status === 'stopping';
  const busy = state.busy.has(instance.id);
  const actions = [];
  const inherited = inheritSummary(instance);

  if (running) {
    actions.push(`<button class="btn btn-primary" data-action="open" ${busy ? 'disabled' : ''}>${ICON.open}打开</button>`);
  } else if (starting) {
    actions.push(`<button class="btn" disabled><span class="spin" style="display:inline-flex">${ICON.refresh}</span>启动中</button>`);
  } else {
    actions.push(`<button class="btn btn-primary" data-action="start" ${busy || stopping ? 'disabled' : ''}>${ICON.play}启动</button>`);
  }

  if (running || starting || stopping) {
    actions.push(`<button class="btn" data-action="stop" ${busy || stopping ? 'disabled' : ''}>${ICON.stop}停止</button>`);
  }

  return `
    <article class="card ${status.className}" data-id="${attr(instance.id)}">
      <div class="card-top">
        <div class="card-id">
          <div class="avatar">${esc(initialOf(instance.name))}</div>
          <div class="card-title">
            <h3 title="${attr(instance.name)}">${esc(instance.name)}</h3>
            <p>${esc(instance.id)}</p>
          </div>
        </div>
        <span class="status ${status.className}"><span class="dot"></span>${status.label}</span>
      </div>
      <div class="path-row" title="${attr(instance.workdir)}">
        ${ICON.folder}
        <code>${esc(instance.workdir)}</code>
        <button class="copy-btn" data-copy="${attr(instance.workdir)}" title="复制工作目录">${ICON.copy}</button>
      </div>
      <div class="chips">
        ${chip('端口', instance.port)}
        ${chip('插件', instance.pluginCount)}
        ${instance.autoStart ? chip('自动启动', undefined, ICON.clock, 'auto') : ''}
        ${inherited.length ? chip('继承', inherited.join('/'), ICON.plug, 'inherit') : ''}
        ${instance.lastStartedAt ? chip('上次启动', timeAgo(instance.lastStartedAt)) : ''}
      </div>
      ${instance.error ? `<div class="card-error" title="${attr(instance.error)}">${esc(instance.error)}</div>` : ''}
      <div class="card-actions">
        ${actions.join('')}
        <span class="spacer"></span>
        <button class="icon-btn" data-action="logs" title="查看日志">${ICON.terminal}</button>
        <button class="icon-btn" data-action="profile" title="实例详情与目录">${ICON.info}</button>
        <button class="icon-btn" data-action="export" title="导出实例配置与数据">${ICON.download}</button>
        <button class="icon-btn" data-action="edit" title="编辑">${ICON.edit}</button>
        <button class="icon-btn" data-action="delete" title="删除">${ICON.trash}</button>
      </div>
    </article>`;
}

function filteredInstances() {
  const query = state.search.trim().toLowerCase();
  if (!query) return state.instances;
  return state.instances.filter((instance) =>
    `${instance.name} ${instance.workdir} ${instance.rootDir} ${instance.id}`.toLowerCase().includes(query),
  );
}

function render() {
  const instances = state.instances;
  const running = instances.filter((item) => item.status === 'running').length;
  const errors = instances.filter((item) => item.status === 'error').length;
  const desktop = state.manager.desktop || {};
  const installDir = state.manager.dshInstallDir || '';

  $('stat-total').textContent = String(instances.length);
  $('stat-running').textContent = String(running);
  $('stat-desktop').textContent = desktop.present ? String(desktop.totals?.plugins ?? 0) : '未找到';
  $('stat-desktop').title = desktop.homeDir || '';
  $('stat-desktop-note').textContent = desktop.present ? '个桌面插件可复制' : '启动一次 DSH Desktop';
  $('stat-install').textContent = installDir ? '已检测' : '未找到';
  $('stat-install').title = installDir || '';
  $('stat-install-note').textContent = installDir ? baseName(installDir) : '请在设置中指定';
  $('stat-running-note').textContent = errors ? `${errors} 个实例异常` : running ? '服务正常' : '等待启动';
  $('instances-sub').textContent = instances.length
    ? `${instances.length} 个实例 · ${running} 个运行中${state.offline ? ' · 连接中断' : ''}`
    : '创建实例后在这里管理';

  const list = filteredInstances();
  $('instance-grid').innerHTML = list.map(cardHtml).join('');
  const empty = $('empty');
  if (instances.length === 0) {
    empty.hidden = false;
    $('instance-grid').hidden = true;
  } else {
    empty.hidden = true;
    $('instance-grid').hidden = false;
    if (list.length === 0) {
      $('instance-grid').innerHTML = '<div class="picker-empty" style="grid-column:1/-1">没有匹配的实例</div>';
    }
  }

  $('footer-data').textContent = state.manager.dataDir || '—';
  document.title = `${instances.length} 个实例 · DSH 实例管理器`;
}

async function loadState({ silent = false } = {}) {
  try {
    const data = await api('/api/state');
    state.instances = Array.isArray(data.instances) ? data.instances : [];
    state.manager = data.manager || {};
    state.offline = false;
    if (!state.desktop && state.manager.desktop) state.desktop = state.manager.desktop;
    render();
    if (!state.settings) state.settings = state.manager;
  } catch (error) {
    state.offline = true;
    render();
    if (!silent) toast(`无法连接管理器：${error.message}`, 'error');
  }
}

function openModal(element) {
  element.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal(element) {
  element.hidden = true;
  if (![...document.querySelectorAll('.modal')].some((modal) => !modal.hidden)) {
    document.body.style.overflow = '';
  }
}

function closeAllModals() {
  for (const modal of document.querySelectorAll('.modal')) modal.hidden = true;
  document.body.style.overflow = '';
  stopLogsPolling();
}

function setFormError(element, message) {
  if (!message) {
    element.hidden = true;
    element.textContent = '';
    return;
  }
  element.hidden = false;
  element.textContent = message;
}

/* ---------------- Directory plan ---------------- */

function suggestedRoot(name) {
  const base = (state.manager.dataDir || '').trim();
  if (!base) return '';
  const slug = slugifyName(name) || 'instance';
  return joinPath(base, 'instances', `${slug}-${randomSuffix()}`);
}

function dirDefaults(root, homeOverride = '') {
  const home = homeOverride || (root ? joinPath(root, 'home') : '');
  return {
    homeDir: home,
    sessionsDir: home ? joinPath(home, 'sessions') : '',
    pluginsDir: home ? joinPath(home, 'profiles', 'web') : '',
    workdir: root ? joinPath(root, 'work') : '',
    logsDir: root ? joinPath(root, 'logs') : '',
  };
}

function inputForDir(key) {
  const field = DIR_FIELDS.find((item) => item.key === key);
  return field ? $(field.input) : null;
}

function refreshDerivedDirs({ force = false } = {}) {
  const root = $('field-root').value.trim();
  if (!root) return;
  const rootDefaults = dirDefaults(root);
  if (force || !state.dirTouched.has('homeDir')) $('field-home').value = rootDefaults.homeDir;
  const home = $('field-home').value.trim() || rootDefaults.homeDir;
  const next = dirDefaults(root, home);
  for (const key of ['sessionsDir', 'pluginsDir', 'workdir', 'logsDir']) {
    if (!force && state.dirTouched.has(key)) continue;
    inputForDir(key).value = next[key];
  }
}

function collectPaths() {
  const paths = {};
  for (const field of DIR_FIELDS) paths[field.key] = $(field.input).value.trim();
  return paths;
}

function updateProgramNote() {
  const detected = state.manager.dshInstallDir || state.desktopInstall?.installDir || '';
  const note = $('program-note');
  if (!note) return;
  note.textContent = detected
    ? `留空则使用自动检测到的安装目录：${detected}`
    : '留空则使用管理器全局自动检测结果（当前未找到，可在设置中指定）';
}

function renderDesktopSummary() {
  const status = $('desktop-status');
  const desktop = state.desktop;
  const pluginsBox = $('inherit-plugins');
  const credentialsBox = $('inherit-credentials');
  const configBox = $('inherit-config');
  const notePlugins = $('inherit-plugins-note');
  const noteCredentials = $('inherit-credentials-note');
  const noteConfig = $('inherit-config-note');
  if (!desktop) {
    if (status) status.textContent = '尚未读取桌面配置';
    return;
  }
  const totals = desktop.totals || {};
  if (!desktop.present) {
    status.textContent = `未找到桌面 profile（${desktop.homeDir || '—'}）。请先启动一次 DSH Desktop，或在设置中指定桌面配置目录。`;
    for (const box of [pluginsBox, credentialsBox, configBox]) {
      if (box) {
        box.disabled = true;
        box.checked = false;
      }
    }
    if (notePlugins) notePlugins.textContent = '不可用';
    if (noteCredentials) noteCredentials.textContent = '不可用';
    if (noteConfig) noteConfig.textContent = '不可用';
    return;
  }
  status.textContent = `已找到：${desktop.profileDir} · ${totals.plugins || 0} 个插件 · ${totals.credentials || 0} 个 API KEY · ${totals.configEntries || 0} 条配置`;
  const size = desktop.nodeModules?.bytes ? `，node_modules ${formatBytes(desktop.nodeModules.bytes)}` : '';
  if (notePlugins) notePlugins.textContent = `bundles：${(desktop.bundles || []).join('、') || '无'}${size}`;
  if (noteCredentials) {
    const names = desktop.credentials?.names || [];
    noteCredentials.textContent = names.length ? names.join('、') : '桌面配置中没有保存的 API KEY';
  }
  if (noteConfig) {
    const ids = desktop.config?.entryIds || [];
    noteConfig.textContent = ids.length ? ids.slice(0, 8).join('、') + (ids.length > 8 ? '…' : '') : '无可复制的配置层';
  }
  const canPlugins = (desktop.totals?.plugins || 0) > 0 || (desktop.bundles || []).length > 0;
  const canCredentials = (desktop.totals?.credentials || 0) > 0;
  const canConfig = Boolean(desktop.config?.hasContent || desktop.homeConfig?.hasContent);
  if (pluginsBox) {
    pluginsBox.disabled = !canPlugins;
    if (!canPlugins) pluginsBox.checked = false;
  }
  if (credentialsBox) {
    credentialsBox.disabled = !canCredentials;
    if (!canCredentials) credentialsBox.checked = false;
  }
  if (configBox) {
    configBox.disabled = !canConfig;
    if (!canConfig) configBox.checked = false;
  }
}

function applyInheritDefaults(desktop) {
  $('inherit-plugins').checked = Boolean(desktop?.present && (desktop.totals?.plugins || 0) > 0);
  $('inherit-credentials').checked = Boolean(desktop?.present && (desktop.totals?.credentials || 0) > 0);
  $('inherit-config').checked = Boolean(
    desktop?.present && (desktop.config?.hasContent || desktop.homeConfig?.hasContent),
  );
}

async function loadDesktop({ applyDefaults = false } = {}) {
  $('desktop-status').textContent = '正在读取桌面配置…';
  try {
    const data = await api('/api/desktop');
    state.desktop = data.desktop;
    state.desktopInstall = data.install;
    if (applyDefaults) applyInheritDefaults(data.desktop);
    renderDesktopSummary();
    updateProgramNote();
  } catch (error) {
    state.desktop = null;
    $('desktop-status').textContent = `读取失败：${error.message}`;
  }
}

function openInstanceModal(instance = null) {
  state.editingId = instance ? instance.id : null;
  state.dirTouched = new Set();
  state.rootTouched = Boolean(instance);
  $('instance-modal-title').textContent = instance ? '编辑实例' : '新建实例';
  $('instance-modal-sub').textContent = instance
    ? '修改名称、目录或端口；目录与端口在停止后重启才会生效'
    : '选择实例根目录，子目录自动生成，也可以逐个修改';
  $('field-name').value = instance ? instance.name : '';
  $('field-port').value = instance ? instance.port : '';
  $('field-autostart').checked = instance ? Boolean(instance.autoStart) : false;
  $('inherit-section').hidden = Boolean(instance);

  if (instance) {
    const layout = instance.layout || {};
    $('field-root').value = layout.rootDir || instance.rootDir || '';
    for (const field of DIR_FIELDS) $(field.input).value = layout[field.key] || '';
    for (const field of DIR_FIELDS) state.dirTouched.add(field.key);
  } else {
    const root = suggestedRoot('');
    $('field-root').value = root;
    for (const field of DIR_FIELDS) $(field.input).value = '';
    refreshDerivedDirs({ force: true });
    $('field-program').value = state.manager.dshInstallDir || state.desktopInstall?.installDir || '';
    if (state.desktop?.present) applyInheritDefaults(state.desktop);
    if (!state.manager.dataDir) {
      loadState({ silent: true }).then(() => {
        if ($('field-root').value) return;
        const nextRoot = suggestedRoot('');
        if (!nextRoot) return;
        $('field-root').value = nextRoot;
        refreshDerivedDirs({ force: true });
        if (!$('field-program').value) $('field-program').value = state.manager.dshInstallDir || '';
      });
    }
    loadDesktop({ applyDefaults: true });
  }
  updateProgramNote();
  setFormError($('instance-error'), '');
  $('btn-submit-instance').textContent = instance ? '保存修改' : '创建实例';
  openModal($('modal-instance'));
  setTimeout(() => $('field-name').focus(), 40);
}

function inheritanceToast(created) {
  const inheritance = created.inheritance;
  if (!inheritance) {
    toast('实例已创建', 'success');
    return;
  }
  const parts = [];
  if (inheritance.plugins?.ok) parts.push(`插件 ${inheritance.plugins.dependencies} 个`);
  if (inheritance.credentials?.ok && inheritance.credentials.added) parts.push(`API KEY ${inheritance.credentials.added} 个`);
  if (inheritance.config?.ok) parts.push('配置层');
  const warnings = inheritance.warnings || [];
  if (warnings.length) {
    toast(`实例已创建；${warnings.slice(0, 2).join('；')}`, 'error', 9000);
  } else if (parts.length) {
    toast(`实例已创建，已从桌面复制 ${parts.join('、')}`, 'success', 6500);
  } else {
    toast('实例已创建', 'success');
  }
}

async function submitInstance(event) {
  event.preventDefault();
  const button = $('btn-submit-instance');
  const name = $('field-name').value.trim();
  const rootDir = $('field-root').value.trim();
  const portText = $('field-port').value.trim();
  const autoStart = $('field-autostart').checked;
  setFormError($('instance-error'), '');
  if (!name) return setFormError($('instance-error'), '请填写实例名称');
  if (!rootDir) return setFormError($('instance-error'), '请选择实例根目录');
  if (portText && (!/^\d+$/.test(portText) || Number(portText) < 1024 || Number(portText) > 65535)) {
    return setFormError($('instance-error'), '端口必须是 1024–65535 之间的整数');
  }
  const payload = {
    name,
    rootDir,
    paths: collectPaths(),
    autoStart,
  };
  if (portText) payload.port = Number(portText);

  button.disabled = true;
  button.textContent = state.editingId ? '保存中…' : '创建中…';
  try {
    if (state.editingId) {
      await api(`/api/instances/${encodeURIComponent(state.editingId)}`, { method: 'PATCH', body: payload });
      toast('实例已更新', 'success');
    } else {
      payload.inherit = {
        plugins: $('inherit-plugins').checked,
        credentials: $('inherit-credentials').checked,
        config: $('inherit-config').checked,
      };
      const created = await api('/api/instances', { method: 'POST', body: payload });
      inheritanceToast(created);
    }
    closeModal($('modal-instance'));
    await loadState({ silent: true });
  } catch (error) {
    setFormError($('instance-error'), error.message);
  } finally {
    button.disabled = false;
    button.textContent = state.editingId ? '保存修改' : '创建实例';
  }
}

async function startInstance(id) {
  if (state.busy.has(id)) return;
  state.busy.add(id);
  render();
  try {
    await api(`/api/instances/${encodeURIComponent(id)}/start`, { method: 'POST' });
    toast('实例已启动', 'success');
  } catch (error) {
    toast(`启动失败：${error.message}`, 'error', 7000);
  } finally {
    state.busy.delete(id);
    await loadState({ silent: true });
  }
}

async function stopInstance(id) {
  if (state.busy.has(id)) return;
  state.busy.add(id);
  render();
  try {
    await api(`/api/instances/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    toast('实例已停止', 'success');
  } catch (error) {
    toast(`停止失败：${error.message}`, 'error');
  } finally {
    state.busy.delete(id);
    await loadState({ silent: true });
  }
}

function openInstanceUrl(instance) {
  if (!instance.url) return toast('实例尚未就绪', 'error');
  window.open(instance.url, '_blank', 'noopener,noreferrer');
}

async function openLogs(id) {
  const instance = state.instances.find((item) => item.id === id);
  if (!instance) return;
  state.logsId = id;
  $('logs-title').textContent = `${instance.name} · 日志`;
  $('logs-sub').textContent = '显示最近 300 行，启动过程中每 2 秒刷新';
  $('logs-pre').textContent = '加载中…';
  openModal($('modal-logs'));
  await refreshLogs();
  stopLogsPolling();
  state.logsTimer = setInterval(() => {
    if ($('modal-logs').hidden) return stopLogsPolling();
    refreshLogs();
  }, 2000);
}

async function refreshLogs() {
  if (!state.logsId) return;
  try {
    const data = await api(`/api/instances/${encodeURIComponent(state.logsId)}/logs?lines=300`);
    const pre = $('logs-pre');
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
    pre.textContent = data.text || '（暂无日志）';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch (error) {
    $('logs-pre').textContent = `读取日志失败：${error.message}`;
  }
}

function stopLogsPolling() {
  if (state.logsTimer) clearInterval(state.logsTimer);
  state.logsTimer = null;
}

const DIRECTORY_ROWS = [
  { kind: 'root', key: 'rootDir', label: '实例根目录' },
  { kind: 'program', key: 'programDir', label: '程序目录' },
  { kind: 'home', key: 'homeDir', label: '数据目录（DSH_HOME）' },
  { kind: 'sessions', key: 'sessionsDir', label: '会话目录' },
  { kind: 'plugins', key: 'pluginsDir', label: '插件目录' },
  { kind: 'workdir', key: 'workdir', label: '工作目录' },
  { kind: 'logs', key: 'logsDir', label: '日志目录' },
];

function directoryRowsHtml(instance) {
  return DIRECTORY_ROWS.map((row) => {
    const value = instance[row.key] || instance.layout?.[row.key] || '';
    if (!value) {
      return `<div class="detail-path muted"><span class="detail-label">${esc(row.label)}</span><code>自动检测 / 未设置</code></div>`;
    }
    return `<div class="detail-path">
      <span class="detail-label">${esc(row.label)}</span>
      <code title="${attr(value)}">${esc(value)}</code>
      <button class="copy-btn" data-copy="${attr(value)}" title="复制">${ICON.copy}</button>
      <button class="btn btn-sm btn-ghost" data-open="${attr(row.kind)}">打开</button>
    </div>`;
  }).join('');
}

async function openProfile(id) {
  const instance = state.instances.find((item) => item.id === id);
  if (!instance) return;
  state.profileId = id;
  $('profile-title').textContent = `${instance.name} · 实例详情`;
  $('profile-body').innerHTML = '<div class="detail-empty">加载中…</div>';
  openModal($('modal-profile'));
  try {
    const info = await api(`/api/instances/${encodeURIComponent(id)}/profile`);
    const merged = { ...instance, ...info };
    const deps = info.dependencies.length
      ? `<div class="dep-list">${info.dependencies.map((name) => `<span class="dep">${esc(name)}</span>`).join('')}</div>`
      : '<div class="detail-empty">尚未安装任何插件。可在该实例的 DSH 设置中安装，也可以复制桌面的插件。</div>';
    const inherit = instance.inherit || {};
    $('profile-body').innerHTML = `
      <div class="detail-section">
        <h3>目录规划</h3>
        <div class="detail-paths">${directoryRowsHtml(merged)}</div>
      </div>
      <div class="detail-section">
        <h3>桌面配置继承</h3>
        <div class="sync-box">
          <label class="check-line"><input type="checkbox" id="sync-plugins" ${inherit.plugins ? 'checked' : ''}> <span>插件（bundle + node_modules）</span></label>
          <label class="check-line"><input type="checkbox" id="sync-credentials" ${inherit.credentials ? 'checked' : ''}> <span>API KEY（只复制密钥引用）</span></label>
          <label class="check-line"><input type="checkbox" id="sync-config" ${inherit.config ? 'checked' : ''}> <span>配置层（模型、权限等）</span></label>
          <div class="sync-actions">
            <button class="btn btn-sm" id="profile-sync">${ICON.sync}从桌面同步</button>
            <span class="hint">${instance.inheritedAt ? `上次同步：${timeAgo(instance.inheritedAt)}` : '尚未从桌面复制过配置'}</span>
          </div>
          <p class="hint">同步前需要先停止实例。已存在的插件与 API KEY 不会被覆盖。</p>
        </div>
      </div>
      <div class="detail-section">
        <h3>已安装插件 <span class="chip">${info.dependencies.length}</span></h3>
        ${deps}
      </div>
      <div class="detail-section">
        <h3>插件安装命令</h3>
        <pre class="detail-command">${esc(info.installCommand)}</pre>
        <div style="margin-top:7px"><button class="btn btn-sm" data-copy="${attr(info.installCommand)}">${ICON.copy}复制命令</button></div>
        <p class="hint" style="margin-top:7px">每个实例的插件安装在各自的数据目录中，互不影响。也可以直接在每个实例的 Web UI「设置 → 插件」中安装。</p>
      </div>`;
  } catch (error) {
    $('profile-body').innerHTML = `<div class="form-error">${esc(error.message)}</div>`;
  }
}

async function syncProfile() {
  if (!state.profileId) return;
  const button = $('profile-sync');
  const inherit = {
    plugins: $('sync-plugins').checked,
    credentials: $('sync-credentials').checked,
    config: $('sync-config').checked,
  };
  if (!inherit.plugins && !inherit.credentials && !inherit.config) return toast('请至少选择一项要同步的内容', 'error');
  button.disabled = true;
  button.textContent = '同步中…';
  try {
    const result = await api(`/api/instances/${encodeURIComponent(state.profileId)}/sync-desktop`, {
      method: 'POST',
      body: { inherit },
    });
    const warnings = result.inheritance?.warnings || [];
    if (warnings.length) toast(`已同步；${warnings.slice(0, 2).join('；')}`, 'error', 9000);
    else toast('桌面配置已同步', 'success');
    await loadState({ silent: true });
    await openProfile(state.profileId);
  } catch (error) {
    toast(`同步失败：${error.message}`, 'error', 8000);
    button.disabled = false;
    button.textContent = '从桌面同步';
  }
}

function openDelete(id) {
  const instance = state.instances.find((item) => item.id === id);
  if (!instance) return;
  state.deleteId = id;
  $('delete-name').textContent = instance.name;
  $('delete-data').checked = true;
  setFormError($('delete-error'), '');
  openModal($('modal-delete'));
}

async function confirmDelete() {
  if (!state.deleteId) return;
  const button = $('btn-confirm-delete');
  const id = state.deleteId;
  button.disabled = true;
  button.textContent = '删除中…';
  try {
    const deleteData = $('delete-data').checked ? '1' : '0';
    const result = await api(`/api/instances/${encodeURIComponent(id)}?deleteData=${deleteData}`, { method: 'DELETE' });
    if (result && Array.isArray(result.keptPaths) && result.keptPaths.length) {
      toast(`实例记录已删除；自定义目录保留在：${result.keptPaths[0]}`, 'info', 8000);
    } else {
      toast('实例已删除', 'success');
    }
    closeModal($('modal-delete'));
    state.deleteId = null;
    await loadState({ silent: true });
  } catch (error) {
    setFormError($('delete-error'), error.message);
  } finally {
    button.disabled = false;
    button.textContent = '删除实例';
  }
}

/* ---------------- Directory picker ---------------- */

async function openPicker(initialPath = '', target = null, title = '选择目录') {
  state.picker.path = initialPath || '';
  state.picker.current = '';
  state.picker.target = target;
  state.picker.title = title;
  $('picker-title').textContent = title;
  openModal($('modal-picker'));
  await loadPickerPath(initialPath || '');
}

async function loadPickerPath(target) {
  const list = $('picker-list');
  list.innerHTML = '<div class="picker-empty">加载中…</div>';
  $('picker-quick').innerHTML = '';
  try {
    const data = target
      ? await api(`/api/fs/list?path=${encodeURIComponent(target)}`)
      : await api('/api/fs/list');
    state.picker.current = data.path || '';
    $('picker-path').value = data.path || '';
    $('picker-current').textContent = data.path || '此电脑';
    $('picker-up').disabled = !data.parent && !data.roots;
    if (data.roots) {
      renderRoots(data.entries);
    } else {
      renderPickerEntries(data);
      renderQuickLinks(data);
    }
  } catch (error) {
    if (target) {
      // A stale or not-yet-created path: open the drive list instead of a dead end.
      $('picker-path').value = '';
      state.picker.current = '';
      state.picker.path = '';
      await loadPickerPath('');
      toast('该目录还不存在或无法访问，已返回磁盘列表', 'info', 4200);
      return;
    }
    list.innerHTML = `<div class="picker-empty">无法打开目录：${esc(error.message)}</div>`;
    toast(`无法打开目录：${error.message}`, 'error');
  }
}

function renderRoots(entries) {
  const list = $('picker-list');
  const quick = $('picker-quick');
  quick.innerHTML = entries
    .filter((entry) => entry.name !== '根目录')
    .map((entry) => `<button class="quick-link" data-quick="${attr(entry.path)}">${esc(entry.name)}</button>`)
    .join('');
  list.innerHTML = entries
    .map(
      (entry) => `<button class="picker-item" data-enter="${attr(entry.path)}">
        ${ICON.folder}<span class="name">${esc(entry.name)}</span><span class="meta">${esc(entry.path)}</span>
      </button>`,
    )
    .join('') || '<div class="picker-empty">没有可访问的目录</div>';
}

function renderPickerEntries(data) {
  const list = $('picker-list');
  const rows = [];
  if (data.parent) {
    rows.push(`<button class="picker-item" data-enter="${attr(data.parent)}">${ICON.folder}<span class="name">.. 上一级</span><span class="meta">${esc(data.parent)}</span></button>`);
  }
  for (const entry of data.entries) {
    rows.push(`<button class="picker-item" data-enter="${attr(entry.path)}">
      ${ICON.folder}<span class="name">${esc(entry.name)}${entry.hidden ? ' <span class="meta">隐藏</span>' : ''}</span><span class="meta">${esc(entry.path)}</span>
    </button>`);
  }
  if (data.truncated) rows.push('<div class="picker-empty">目录项过多，仅显示前 500 个</div>');
  list.innerHTML = rows.join('') || '<div class="picker-empty">此目录下没有子文件夹</div>';
}

function renderQuickLinks(data) {
  const quick = $('picker-quick');
  const roots = data.roots || [];
  const items = [];
  if (data.root) items.push({ name: `${data.root} 根目录`, path: data.root });
  for (const entry of roots) {
    if (entry.name === '根目录') continue;
    items.push({ name: entry.name, path: entry.path });
  }
  quick.innerHTML = items
    .slice(0, 8)
    .map((item) => `<button class="quick-link" data-quick="${attr(item.path)}">${esc(item.name)}</button>`)
    .join('');
}

async function enterPickerPath(target) {
  state.picker.path = target;
  await loadPickerPath(target);
}

async function createPickerFolder() {
  const name = $('picker-new-name').value.trim();
  if (!name) return toast('请输入文件夹名称', 'error');
  const parent = state.picker.current;
  if (!parent) return toast('请先进入一个磁盘或文件夹', 'error');
  try {
    const result = await api('/api/fs/mkdir', { method: 'POST', body: { parent, name } });
    $('picker-new-name').value = '';
    toast('文件夹已创建', 'success');
    await loadPickerPath(result.path);
  } catch (error) {
    toast(`创建失败：${error.message}`, 'error');
  }
}

function selectPickerPath() {
  if (!state.picker.current) return toast('请选择一个目录', 'error');
  const target = state.picker.target;
  const input = target ? $(target) : $('field-workdir');
  if (!input) return;
  input.value = state.picker.current;
  if (target === 'field-root') {
    state.rootTouched = true;
    refreshDerivedDirs();
  } else if (target === 'field-home') {
    state.dirTouched.add('homeDir');
    refreshDerivedDirs();
  } else {
    const field = DIR_FIELDS.find((item) => item.input === target);
    if (field) state.dirTouched.add(field.key);
  }
  closeModal($('modal-picker'));
}

/* ---------------- Settings ---------------- */

async function openSettings() {
  openModal($('modal-settings'));
  setFormError($('settings-error'), '');
  $('settings-detected').textContent = '读取中…';
  try {
    const data = await api('/api/settings');
    state.settings = data;
    $('settings-install').value = data.dshInstallDir || '';
    $('settings-desktop').value = data.desktopHome || '';
    $('settings-command').value = data.dshCommand || '';
    $('settings-port').textContent = String(data.managerPort || '—');
    $('settings-version').textContent = data.version || VERSION;
    $('settings-data').textContent = data.dataDir || '—';
    const detected = data.detected || {};
    $('settings-detected').textContent = detected.installDir
      ? `当前使用：${detected.installDir}（${detected.source}）`
      : `未找到 DSH：${detected.source || '请手动指定'}`;
    $('settings-desktop-note').textContent = data.desktop?.present
      ? `桌面 profile：${data.desktop.profileDir} · ${data.desktop.totals?.plugins || 0} 个插件 · ${data.desktop.totals?.credentials || 0} 个 API KEY`
      : `未找到桌面 profile（${data.desktop?.homeDir || '未检测'}）。启动一次 DSH Desktop 即可自动识别。`;
  } catch (error) {
    $('settings-detected').textContent = `读取失败：${error.message}`;
  }
}

async function detectCommand() {
  try {
    const data = await api('/api/settings/detect', { method: 'POST' });
    if (data.installDir) $('settings-install').value = data.installDir;
    if (data.command) $('settings-command').value = data.command;
    $('settings-detected').textContent = data.installDir
      ? `检测到：${data.installDir}（${data.source}）`
      : data.source || '未找到 DSH 安装目录';
    if (data.desktop) {
      $('settings-desktop-note').textContent = data.desktop.present
        ? `桌面 profile：${data.desktop.profileDir} · ${data.desktop.totals?.plugins || 0} 个插件 · ${data.desktop.totals?.credentials || 0} 个 API KEY`
        : `未找到桌面 profile（${data.desktop.homeDir || '未检测'}）`;
    }
  } catch (error) {
    $('settings-detected').textContent = `检测失败：${error.message}`;
  }
}

async function saveSettings() {
  const button = $('settings-save');
  setFormError($('settings-error'), '');
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    const data = await api('/api/settings', {
      method: 'PUT',
      body: {
        dshInstallDir: $('settings-install').value.trim(),
        desktopHome: $('settings-desktop').value.trim(),
        dshCommand: $('settings-command').value.trim(),
      },
    });
    toast('设置已保存', 'success');
    const detected = data.detected || {};
    $('settings-detected').textContent = detected.installDir
      ? `当前使用：${detected.installDir}（${detected.source}）`
      : `未找到 DSH：${detected.source || '请手动指定'}`;
    await loadState({ silent: true });
    if (state.desktop) await loadDesktop();
  } catch (error) {
    setFormError($('settings-error'), error.message);
  } finally {
    button.disabled = false;
    button.textContent = '保存';
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'success', 1800);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      toast('已复制', 'success', 1800);
    } catch {
      toast('复制失败，请手动选择', 'error');
    } finally {
      area.remove();
    }
  }
}

/* ---------------- Import / export ---------------- */

async function downloadFile(url, fallbackName) {
  const response = await fetch(url, { headers: { 'x-dshm-token': TOKEN } });
  if (!response.ok) {
    let message = `导出失败（HTTP ${response.status}）`;
    try {
      const data = JSON.parse(await response.text());
      if (data && data.error) message = data.error;
    } catch {
      // Keep the HTTP message.
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="([^"]+)"/i.exec(disposition);
  const filename = encoded ? decodeURIComponent(encoded[1]) : plain ? plain[1] : fallbackName;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  return { name: filename, bytes: blob.size };
}

function uploadArchive(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('x-dshm-token', TOKEN);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      reject(new Error((data && data.error) || `导入失败（HTTP ${xhr.status}）`));
    });
    xhr.addEventListener('error', () => reject(new Error('上传失败，请重试')));
    xhr.addEventListener('abort', () => reject(new Error('已取消上传')));
    xhr.send(file);
  });
}

function openExport(id) {
  const instance = state.instances.find((item) => item.id === id);
  if (!instance) return;
  state.exportId = id;
  $('export-target').innerHTML = `<strong>${esc(instance.name)}</strong> · 数据目录 ${esc(instance.homeDir)}`;
  const running = instance.status === 'running' || instance.status === 'starting' || instance.status === 'stopping';
  $('btn-do-export').disabled = running;
  setFormError($('export-error'), running ? '实例正在运行：请先停止，再导出。' : '');
  openModal($('modal-export'));
}

async function doExport() {
  if (!state.exportId) return;
  const instance = state.instances.find((item) => item.id === state.exportId);
  const button = $('btn-do-export');
  const params = new URLSearchParams({
    modules: $('export-modules').checked ? '1' : '0',
    credentials: $('export-credentials').checked ? '1' : '0',
    logs: $('export-logs').checked ? '1' : '0',
    work: $('export-work').checked ? '1' : '0',
  });
  setFormError($('export-error'), '');
  button.disabled = true;
  button.textContent = '导出中…';
  try {
    const result = await downloadFile(
      `/api/instances/${encodeURIComponent(state.exportId)}/export?${params}`,
      `dshm-${instance ? instance.name : 'instance'}.zip`,
    );
    toast(`已导出 ${result.name}（${formatBytes(result.bytes)}）`, 'success', 6000);
    closeModal($('modal-export'));
  } catch (error) {
    setFormError($('export-error'), error.message);
  } finally {
    button.disabled = false;
    button.textContent = '开始导出';
  }
}

function openImportInstance() {
  $('import-file').value = '';
  $('import-name').value = '';
  $('import-root').value = '';
  $('import-file-note').textContent = '由本管理器的「导出实例」生成的 .zip 文件';
  $('import-progress').hidden = true;
  setFormError($('import-error'), '');
  $('btn-do-import').disabled = false;
  openModal($('modal-import-instance'));
}

async function doImportInstance() {
  const file = $('import-file').files && $('import-file').files[0];
  if (!file) {
    setFormError($('import-error'), '请先选择要导入的 .zip 归档');
    return;
  }
  const button = $('btn-do-import');
  const progress = $('import-progress');
  const label = $('import-progress-text');
  const query = new URLSearchParams();
  const name = $('import-name').value.trim();
  const rootDir = $('import-root').value.trim();
  if (name) query.set('name', name);
  if (rootDir) query.set('rootDir', rootDir);
  setFormError($('import-error'), '');
  button.disabled = true;
  button.textContent = '导入中…';
  progress.hidden = false;
  label.textContent = `上传中 0%（${formatBytes(file.size)}）`;
  try {
    const result = await uploadArchive(`/api/instances/import?${query}`, file, (ratio) => {
      label.textContent = `上传中 ${Math.round(ratio * 100)}%（${formatBytes(file.size)}）`;
    });
    label.textContent = '正在解压与修复依赖…';
    const instance = result.instance;
    toast(`实例「${instance.name}」已导入（${formatBytes(result.extracted.bytes)}）`, 'success', 6000);
    const sourceRoot = result.manifest && result.manifest.sourceLayout ? result.manifest.sourceLayout.rootDir : '';
    if (sourceRoot && instance && sourceRoot !== instance.layout.rootDir) {
      toast(`归档中的原目录为 ${sourceRoot}，已导入到 ${instance.layout.rootDir}`, 'info', 9000);
    }
    closeModal($('modal-import-instance'));
    await loadState({ silent: true });
  } catch (error) {
    setFormError($('import-error'), error.message);
  } finally {
    button.disabled = false;
    button.textContent = '导入实例';
    progress.hidden = true;
  }
}

async function exportManagerConfig() {
  try {
    const result = await downloadFile('/api/config/export', 'dshm-manager.json');
    toast(`管理器配置已导出：${result.name}`, 'success', 5000);
  } catch (error) {
    toast(`导出失败：${error.message}`, 'error');
  }
}

function triggerConfigImport() {
  $('config-import-file').click();
}

async function handleConfigFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  let data = null;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('无法读取配置文件：不是合法的 JSON', 'error');
    return;
  }
  if (!data || !Array.isArray(data.instances)) {
    toast('这不是管理器配置导出文件', 'error');
    return;
  }
  state.configImport = data;
  const names = data.instances
    .slice(0, 6)
    .map((item) => esc(String((item && (item.name || item.id)) || '?')))
    .join('、');
  $('config-import-summary').innerHTML = [
    `<div>文件：<strong>${esc(file.name)}</strong></div>`,
    `<div>导出时间：${esc(data.exportedAt || '未知')}${data.hostname ? ` · ${esc(data.hostname)}` : ''}</div>`,
    `<div>实例：<strong>${data.instances.length}</strong> 个${names ? `（${names}${data.instances.length > 6 ? '…' : ''}）` : ''}</div>`,
    `<div>设置：${data.settings ? '包含安装目录、桌面目录等偏好' : '未包含'}</div>`,
  ].join('');
  setFormError($('config-import-error'), '');
  openModal($('modal-config-import'));
}

async function doConfigImport() {
  if (!state.configImport) return;
  const checked = document.querySelector('input[name="config-mode"]:checked');
  const mode = checked ? checked.value : 'merge';
  const button = $('btn-do-config-import');
  button.disabled = true;
  button.textContent = '导入中…';
  try {
    const result = await api('/api/config/import', {
      method: 'POST',
      body: { config: state.configImport, mode, applySettings: $('config-apply-settings').checked },
    });
    const parts = [`导入 ${result.imported.length} 个实例`];
    if (result.skipped && result.skipped.length) parts.push(`跳过 ${result.skipped.length} 个`);
    toast(parts.join('，'), 'success', 5000);
    const warnings = result.warnings || [];
    if (warnings.length) toast(warnings.slice(0, 2).join('；'), 'info', 10_000);
    closeModal($('modal-config-import'));
    state.configImport = null;
    await loadState({ silent: true });
  } catch (error) {
    setFormError($('config-import-error'), error.message);
  } finally {
    button.disabled = false;
    button.textContent = '导入';
  }
}

/* ---------------- Event wiring ---------------- */

$('btn-create').addEventListener('click', () => openInstanceModal());
$('btn-empty-create').addEventListener('click', () => openInstanceModal());
$('btn-import-instance').addEventListener('click', openImportInstance);
$('btn-do-export').addEventListener('click', doExport);
$('btn-do-import').addEventListener('click', doImportInstance);
$('settings-export-config').addEventListener('click', exportManagerConfig);
$('settings-import-config').addEventListener('click', triggerConfigImport);
$('btn-do-config-import').addEventListener('click', doConfigImport);
$('config-import-file').addEventListener('change', handleConfigFile);
$('import-file').addEventListener('change', () => {
  const file = $('import-file').files && $('import-file').files[0];
  $('import-file-note').textContent = file
    ? `${file.name} · ${formatBytes(file.size)}`
    : '由本管理器的「导出实例」生成的 .zip 文件';
});
$('modal-import-instance').addEventListener('click', (event) => {
  const browse = event.target.closest('[data-browse]');
  if (!browse) return;
  const target = browse.getAttribute('data-browse');
  if (!target) return;
  openPicker($(target)?.value.trim() || '', target, '选择目录');
});
$('btn-refresh').addEventListener('click', () => loadState().then(() => toast('状态已刷新', 'success', 1600)));
$('btn-settings').addEventListener('click', openSettings);
$('form-instance').addEventListener('submit', submitInstance);
$('btn-confirm-delete').addEventListener('click', confirmDelete);
$('settings-detect').addEventListener('click', detectCommand);
$('settings-save').addEventListener('click', saveSettings);
$('logs-refresh').addEventListener('click', refreshLogs);
$('logs-open').addEventListener('click', () => {
  if (state.logsId) api(`/api/instances/${encodeURIComponent(state.logsId)}/open`, { method: 'POST', body: { kind: 'logs' } }).catch((error) => toast(error.message, 'error'));
});
$('profile-open-root').addEventListener('click', () => {
  if (state.profileId) api(`/api/instances/${encodeURIComponent(state.profileId)}/open`, { method: 'POST', body: { kind: 'root' } }).catch((error) => toast(error.message, 'error'));
});
$('settings-open-data').addEventListener('click', () => {
  api('/api/open-data', { method: 'POST' }).catch((error) => toast(error.message, 'error'));
});
$('btn-refresh-desktop').addEventListener('click', () => loadDesktop({ applyDefaults: false }));
$('btn-reset-dirs').addEventListener('click', () => {
  state.dirTouched.clear();
  refreshDerivedDirs({ force: true });
  toast('子目录已按根目录重算', 'success', 1800);
});

$('field-root').addEventListener('input', () => {
  state.rootTouched = true;
  refreshDerivedDirs();
});
$('field-home').addEventListener('input', () => {
  state.dirTouched.add('homeDir');
  refreshDerivedDirs();
});
for (const key of ['sessionsDir', 'pluginsDir', 'workdir', 'logsDir']) {
  inputForDir(key).addEventListener('input', () => state.dirTouched.add(key));
}
$('field-program').addEventListener('input', updateProgramNote);
$('field-name').addEventListener('input', () => {
  if (state.editingId || state.rootTouched) return;
  const root = suggestedRoot($('field-name').value);
  if (!root) return;
  $('field-root').value = root;
  refreshDerivedDirs({ force: true });
});

$('modal-instance').addEventListener('click', (event) => {
  const browse = event.target.closest('[data-browse]');
  if (browse) {
    const target = browse.getAttribute('data-browse');
    const inputId = target === 'root' ? 'field-root' : `field-${target}`;
    openPicker($(inputId)?.value.trim() || '', inputId, '选择目录');
  }
});

document.addEventListener('click', (event) => {
  const browse = event.target.closest('#modal-settings [data-browse]');
  if (!browse) return;
  const inputId = browse.getAttribute('data-browse');
  if (!inputId) return;
  openPicker($(inputId)?.value.trim() || '', inputId, '选择目录');
});

$('search').addEventListener('input', (event) => {
  state.search = event.target.value;
  render();
});

$('instance-grid').addEventListener('click', (event) => {
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    copyText(copy.getAttribute('data-copy'));
    return;
  }
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const card = button.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  const action = button.dataset.action;
  const instance = state.instances.find((item) => item.id === id);
  if (!instance) return;
  if (action === 'start') startInstance(id);
  else if (action === 'stop') stopInstance(id);
  else if (action === 'open') openInstanceUrl(instance);
  else if (action === 'logs') openLogs(id);
  else if (action === 'profile') openProfile(id);
  else if (action === 'export') openExport(id);
  else if (action === 'edit') openInstanceModal(instance);
  else if (action === 'delete') openDelete(id);
});

$('profile-body').addEventListener('click', (event) => {
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    copyText(copy.getAttribute('data-copy'));
    return;
  }
  const open = event.target.closest('[data-open]');
  if (open && state.profileId) {
    api(`/api/instances/${encodeURIComponent(state.profileId)}/open`, {
      method: 'POST',
      body: { kind: open.getAttribute('data-open') },
    }).catch((error) => toast(error.message, 'error'));
    return;
  }
  const sync = event.target.closest('#profile-sync');
  if (sync) syncProfile();
});

$('picker-list').addEventListener('click', (event) => {
  const target = event.target.closest('[data-enter]');
  if (target) enterPickerPath(target.getAttribute('data-enter'));
});
$('picker-quick').addEventListener('click', (event) => {
  const target = event.target.closest('[data-quick]');
  if (target) enterPickerPath(target.getAttribute('data-quick'));
});
$('picker-up').addEventListener('click', async () => {
  if (!state.picker.current) return;
  const data = await api(`/api/fs/list?path=${encodeURIComponent(state.picker.current)}`).catch(() => null);
  if (data && data.parent) enterPickerPath(data.parent);
  else loadPickerPath('');
});
$('picker-go').addEventListener('click', () => enterPickerPath($('picker-path').value.trim()));
$('picker-path').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    enterPickerPath($('picker-path').value.trim());
  }
});
$('picker-new-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    createPickerFolder();
  }
});
$('picker-mkdir').addEventListener('click', createPickerFolder);
$('picker-select').addEventListener('click', selectPickerPath);

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => {
    const modal = button.closest('.modal');
    if (modal) closeModal(modal);
  });
}
for (const modal of document.querySelectorAll('.modal')) {
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal(modal);
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const open = [...document.querySelectorAll('.modal')].reverse().find((modal) => !modal.hidden);
    if (open) closeModal(open);
  }
});

window.addEventListener('beforeunload', () => stopLogsPolling());

loadState();
setInterval(() => {
  if (!document.hidden) loadState({ silent: true });
}, 2500);
