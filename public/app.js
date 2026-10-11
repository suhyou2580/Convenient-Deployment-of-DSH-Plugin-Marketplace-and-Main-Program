'use strict';

// ---------- 状态 ----------
const state = {
  items: [],        // 已加载的插件
  installed: [],    // 当前 profile 已安装/启用的插件
  view: 'market',
  page: 0,
  size: 24,
  total: 0,
  status: null,
  webStatus: null,  // dsh web 本体（默认 3080）运行状态 { port, running, pids }
  ai: new Map(),    // name -> {intro, tags}
  pendingDeploy: null,  // { kind: 'install'|'remove', item }
};

const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  profile: 'web',
  webPort: 3080,
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
};

function getSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('dshDeployerSettings') || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(s) {
  localStorage.setItem('dshDeployerSettings', JSON.stringify(s));
}

// ---------- 工具 ----------
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
let toastTimer;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

// ---------- SSE（POST + 流式读取） ----------
async function streamPost(url, body, onEvent) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { msg = (await resp.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) {
          try { onEvent(JSON.parse(line.slice(5).trim())); } catch {}
        }
      }
    }
  }
}

// ---------- 环境状态 ----------
async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    state.status = await r.json();
    renderStatus();
    populateProfiles();
    refreshWebStatus();
  } catch (e) {
    $('status').innerHTML = `<span class="chip bad">环境检测失败</span>`;
  }
}

function renderStatus() {
  const s = state.status;
  const chips = [];
  chips.push(s.dshInstalled
    ? `<span class="chip ok">dsh ${esc(s.dshVersion)}</span>`
    : `<span class="chip bad">未检测到 dsh</span>`);
  chips.push(s.pnpmInstalled
    ? `<span class="chip ok">pnpm ${esc(s.pnpmVersion)}</span>`
    : `<span class="chip bad">缺 pnpm</span>`);
  chips.push(webChipHtml());
  $('status').innerHTML = chips.join('');

  $('pnpmBanner').classList.toggle('hidden', !!s.pnpmInstalled);
  $('deployHint').textContent =
    `安装命令：dsh plugin --profile ${s.profiles?.[0] || 'web'} add <包名>　·　装完需重启 dsh web 生效。Profiles 目录：${s.profilesDir}`;
}

// dsh web 本体状态徽章：运行中可点击直接打开本体
function webChipHtml() {
  const ws = state.webStatus;
  if (!ws) return `<span class="chip loading">dsh web 本体 检测中…</span>`;
  if (ws.running) {
    const url = `http://127.0.0.1:${ws.port}/`;
    return `<a class="chip ok link" href="${esc(url)}" target="_blank" rel="noreferrer" title="dsh web 本体运行中，点击打开">dsh web 本体 :${esc(ws.port)} ↗</a>`;
  }
  return `<span class="chip" title="dsh web 本体未运行，点右上按钮启动">dsh web 本体 未运行</span>`;
}

let _lastWebKey;
async function refreshWebStatus() {
  const port = getSettings().webPort || 3080;
  let next;
  try {
    const r = await fetch(`/api/web-status?port=${encodeURIComponent(port)}`);
    next = await r.json();
  } catch {
    next = { port, running: false, pids: [] };
  }
  const key = `${next.port}:${next.running}`;
  const changed = _lastWebKey === undefined || _lastWebKey !== key;
  state.webStatus = next;
  _lastWebKey = key;
  if (changed) {
    if (state.status) renderStatus();
    updateWebButton();
  }
}

function updateWebButton() {
  $('btnRestartWeb').textContent = state.webStatus?.running ? '⟲ 重启 dsh web' : '▶ 启动 dsh web';
}

function populateProfiles() {
  const sel = $('setProfile');
  const s = getSettings();
  const profiles = state.status?.profiles?.length ? state.status.profiles : ['web'];
  sel.innerHTML = profiles.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  sel.value = profiles.includes(s.profile) ? s.profile : profiles[0];
}

// ---------- 加载插件 ----------
async function loadPlugins(reset) {
  const btn = $('btnLoad');
  if (reset) {
    state.page = 0;
    state.items = [];
    state.ai.clear();
    state.total = 0;
  }
  state.size = Number($('sizeSel').value) || 24;
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '搜索中…';
  try {
    const q = $('filterText').value.trim();
    const url = `/api/search?page=${state.page}&size=${state.size}&q=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    // 去重合并
    const seen = new Set(state.items.map((i) => i.name));
    for (const it of data.items) {
      if (!seen.has(it.name)) { state.items.push(it); seen.add(it.name); }
    }
    state.total = data.total;
    $('filters').classList.remove('hidden');
    $('empty').classList.add('hidden');
    $('btnMore').disabled = state.items.length >= state.total;
    render();
    if (reset) toast(`已加载 ${data.items.length} 个插件（共约 ${fmtNum(data.total)} 个）`, 'ok');
  } catch (e) {
    toast('搜索失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

// ---------- 排序 / 过滤 ----------
function visibleItems() {
  const text = $('filterText').value.trim().toLowerCase();
  let list = state.items.slice();
  if (text) {
    list = list.filter((i) =>
      i.name.toLowerCase().includes(text) ||
      (i.description || '').toLowerCase().includes(text) ||
      (i.keywords || []).some((k) => k.toLowerCase().includes(text)));
  }
  const sort = $('sortBy').value;
  if (sort === 'downloads') list.sort((a, b) => (b.monthlyDownloads || 0) - (a.monthlyDownloads || 0));
  else if (sort === 'recent') list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

// ---------- 渲染 ----------
function render() {
  const list = visibleItems();
  $('meta').textContent = `显示 ${list.length} / 已加载 ${state.items.length} 个（社区共约 ${fmtNum(state.total)} 个 dsh 插件）`;
  $('grid').innerHTML = list.map(cardHtml).join('');
  bindCardEvents();
}

function cardHtml(it) {
  const ai = state.ai.get(it.name);
  const profile = getSettings().profile || 'web';
  const cmd = `dsh plugin --profile ${profile} add ${it.name}`;
  const desc = it.description || '（该插件未提供描述）';
  const repo = it.links.repository ? String(it.links.repository).replace(/^git\+/, '').replace(/\.git$/, '') : null;

  let aiHtml = '';
  if (ai && ai.intro) {
    aiHtml = `<div class="ai-box">
      <div>${esc(ai.intro)}</div>
      ${ai.tags?.length ? `<div class="tags">${ai.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    </div>`;
  } else if (ai && ai.error) {
    aiHtml = `<div class="ai-box err">AI 简介失败：${esc(ai.error)}</div>`;
  } else if (ai && ai.pending) {
    aiHtml = `<div class="ai-box pending">AI 生成中…</div>`;
  }

  return `<div class="card" data-name="${esc(it.name)}">
    <div class="card-head">
      <div class="card-name"><a href="${esc(it.links.npm)}" target="_blank" rel="noreferrer">${esc(it.name)}</a></div>
      <div class="card-badges">
        <span class="badge">v${esc(it.version || '?')}</span>
        <span class="badge dl">↓ ${fmtNum(it.monthlyDownloads)}/月</span>
      </div>
    </div>
    <div class="desc clamp" data-role="desc">${esc(desc)}</div>
    <div class="toggle-desc" data-role="toggle">展开</div>
    ${aiHtml}
    <div class="card-links">
      <a href="${esc(it.links.npm)}" target="_blank" rel="noreferrer">npm</a>
      ${it.links.homepage ? `<a href="${esc(it.links.homepage)}" target="_blank" rel="noreferrer">主页</a>` : ''}
      ${repo ? `<a href="${esc(repo)}" target="_blank" rel="noreferrer">仓库</a>` : ''}
    </div>
    <div class="card-actions">
      <button class="btn deploy" data-act="deploy">一键部署</button>
      <button class="btn ghost small" data-act="copy">复制命令</button>
      <button class="btn ai small" data-act="ai">✦ AI 简介</button>
    </div>
  </div>`;
}

function bindCardEvents() {
  document.querySelectorAll('.card').forEach((card) => {
    const name = card.dataset.name;
    const item = state.items.find((i) => i.name === name);

    const toggle = card.querySelector('[data-role="toggle"]');
    toggle?.addEventListener('click', () => {
      const d = card.querySelector('[data-role="desc"]');
      d.classList.toggle('clamp');
      toggle.textContent = d.classList.contains('clamp') ? '展开' : '收起';
    });

    card.querySelector('[data-act="deploy"]')?.addEventListener('click', () => askDeploy(item));
    card.querySelector('[data-act="copy"]')?.addEventListener('click', () => {
      const profile = getSettings().profile || 'web';
      copyText(`dsh plugin --profile ${profile} add ${item.name}`);
    });
    card.querySelector('[data-act="ai"]')?.addEventListener('click', () => genOne(item));
  });
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(
    () => toast('已复制：' + text, 'ok'),
    () => toast('复制失败，请手动选择', 'err')
  );
}

// ---------- 部署 / 卸载 / 重启 流程 ----------
function askDeploy(item) {
  const profile = getSettings().profile || 'web';
  openConfirm({
    title: '确认部署',
    command: `dsh plugin --profile ${profile} add ${item.name}`,
    note: `目标 profile：${profile}　·　插件：${item.name}`,
    okText: '确认安装', okClass: 'primary',
    payload: { kind: 'install', item },
  });
}

function askRemove(item) {
  const profile = getSettings().profile || 'web';
  openConfirm({
    title: '确认卸载',
    command: `dsh plugin --profile ${profile} remove ${item.name}`,
    note: `目标 profile：${profile}　·　插件：${item.name}`,
    okText: '确认卸载', okClass: 'warn',
    payload: { kind: 'remove', item },
  });
}

function askRestart() {
  const port = getSettings().webPort || 3080;
  const running = state.webStatus?.running;
  openConfirm({
    title: running ? '确认重启 dsh web 本体' : '确认启动 dsh web 本体',
    command: running ? `重启 127.0.0.1:${port} 上的 dsh web` : `启动 dsh web（监听 127.0.0.1:${port}）`,
    note: running
      ? '⚠ 会终止当前 dsh web 进程，你当前的浏览器会话将失效；重启后会自动打开新标签页（新 token）。'
      : '将执行 dsh web 拉起本体，启动成功后会自动打开浏览器。装完插件后需要它来生效。',
    okText: running ? '确认重启' : '确认启动', okClass: 'warn',
    payload: { kind: 'restart', port },
  });
}

function openConfirm({ title, command, note, okText, okClass, payload }) {
  state.pendingDeploy = payload;
  $('confirmTitle').textContent = title;
  $('confirmCmd').textContent = command;
  $('confirmName').textContent = note;
  const ok = $('btnDoConfirm');
  ok.textContent = okText;
  ok.className = 'btn ' + okClass;
  $('confirmOverlay').classList.remove('hidden');
  $('confirmOverlay').classList.add('center');
}

function openLog(title, hint) {
  $('logOverlay').classList.remove('hidden');
  $('logTitle').textContent = title;
  $('logOut').textContent = '';
  $('logHint').textContent = hint || '';
  return (text) => {
    const out = $('logOut');
    out.textContent += text;
    out.scrollTop = out.scrollHeight;
  };
}

async function doDeploy() {
  const pending = state.pendingDeploy;
  $('confirmOverlay').classList.add('hidden');
  if (!pending) return;
  if (pending.kind === 'restart') return doRestart(pending.port);

  const profile = getSettings().profile || 'web';
  const { kind, item } = pending;

  const append = openLog(`${kind === 'install' ? '部署' : '卸载'}日志：${item.name}`,
    kind === 'install' ? '正在安装…' : '正在卸载…');

  const endpoint = kind === 'install' ? '/api/deploy' : '/api/plugin/remove';
  const doneMsg = kind === 'install' ? '安装成功' : '卸载成功';

  try {
    await streamPost(endpoint, { package: item.name, profile }, (ev) => {
      if (ev.type === 'start') append(`$ ${ev.command}\n\n`);
      else if (ev.type === 'out') append(ev.text);
      else if (ev.type === 'error') append(`\n[错误] ${ev.message}\n`);
      else if (ev.type === 'done') {
        if (ev.code === 0) {
          append(`\n[完成] ${doneMsg}。请重启 dsh web 使其生效。`);
          $('logHint').textContent = `${doneMsg} ✅ 重启 dsh web 后生效`;
          toast(`${doneMsg}，记得重启 dsh web`, 'ok');
          if (state.view === 'installed') loadInstalled();
        } else {
          append(`\n[失败] 退出码 ${ev.code}。请查看上方日志。`);
          $('logHint').textContent = `${kind === 'install' ? '安装' : '卸载'}失败（退出码 ${ev.code}）`;
          toast('操作失败，见日志', 'err');
        }
      }
    });
  } catch (e) {
    append(`\n[错误] ${e.message}\n`);
    $('logHint').textContent = '请求失败：' + e.message;
  }
}

async function doRestart(port) {
  const append = openLog('启动 / 重启 dsh web', `正在操作 127.0.0.1:${port} …`);
  try {
    await streamPost('/api/restart-web', { port }, (ev) => {
      if (ev.type === 'out') append(ev.text);
      else if (ev.type === 'error') append(`\n[错误] ${ev.message}\n`);
      else if (ev.type === 'done') {
        if (ev.code === 0) {
          append(`\n[完成] dsh web 本体已就绪：${ev.url}\n浏览器应已自动打开；也可点顶部状态徽章打开本体。\n`);
          $('logHint').textContent = '本体已就绪 ✅ ' + ev.url;
          toast('dsh web 本体已就绪', 'ok');
        } else {
          append('\n[失败] 本体未启动成功，请查看上方日志。\n');
          $('logHint').textContent = '启动/重启失败';
          toast('本体启动失败，见日志', 'err');
        }
      }
    });
  } catch (e) {
    append(`\n[错误] ${e.message}\n`);
    $('logHint').textContent = '请求失败：' + e.message;
  }
  refreshWebStatus();
}

async function installPnpm() {
  const append = openLog('安装 pnpm', '正在全局安装 pnpm…');
  try {
    await streamPost('/api/deploy-pnpm', {}, (ev) => {
      if (ev.type === 'start') append(`$ ${ev.command}\n\n`);
      else if (ev.type === 'out') append(ev.text);
      else if (ev.type === 'error') append(`\n[错误] ${ev.message}\n`);
      else if (ev.type === 'done') {
        append(ev.code === 0 ? '\n[完成] pnpm 安装成功。' : `\n[失败] 退出码 ${ev.code}`);
        $('logHint').textContent = ev.code === 0 ? 'pnpm 已安装 ✅' : '安装失败';
        if (ev.code === 0) { loadStatus(); toast('pnpm 安装成功', 'ok'); }
      }
    });
  } catch (e) {
    append(`\n[错误] ${e.message}\n`);
  }
}

// ---------- 已安装管理 ----------
function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('viewMarket').classList.toggle('hidden', view !== 'market');
  $('viewInstalled').classList.toggle('hidden', view !== 'installed');
  if (view === 'installed') loadInstalled();
}

async function loadInstalled() {
  const profile = getSettings().profile || 'web';
  $('installedEmpty').textContent = '正在读取…';
  $('installedEmpty').classList.remove('hidden');
  $('installedGrid').innerHTML = '';
  try {
    const r = await fetch(`/api/installed?profile=${encodeURIComponent(profile)}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    state.installed = data.plugins;
    renderInstalled();
  } catch (e) {
    $('installedEmpty').textContent = '读取失败：' + e.message;
  }
}

function renderInstalled() {
  const profile = getSettings().profile || 'web';
  const list = state.installed;
  const userCount = list.filter((p) => !p.builtin).length;
  $('installedMeta').textContent = `profile「${profile}」：${userCount} 个可管理插件 + ${list.length - userCount} 个内置 bundle`;
  $('installedEmpty').classList.toggle('hidden', list.length > 0);
  $('installedGrid').innerHTML = list.map(installedCardHtml).join('');
  bindInstalledEvents();
}

function installedCardHtml(p) {
  const statusBadge = p.builtin
    ? `<span class="badge core">内置</span>`
    : p.enabled
      ? `<span class="badge on">已启用</span>`
      : `<span class="badge off">已禁用</span>`;
  const npmUrl = `https://www.npmjs.com/package/${p.name}`;
  const checked = p.enabled ? 'checked' : '';
  const disabledAttr = p.builtin ? 'disabled' : '';
  const title = p.builtin ? '内置 bundle，不可更改/卸载' : (p.enabled ? '点击禁用' : '点击启用');

  return `<div class="card" data-name="${esc(p.name)}">
    <div class="card-head">
      <div>
        <div class="card-name"><a href="${esc(npmUrl)}" target="_blank" rel="noreferrer">${esc(p.name)}</a></div>
        <div class="installed-sub">
          ${p.version ? `<span class="badge">${esc(p.version)}</span>` : ''}
          ${statusBadge}
        </div>
      </div>
      <label class="switch" title="${title}">
        <input type="checkbox" ${checked} ${disabledAttr} data-act="toggle" />
        <span class="slider"></span>
      </label>
    </div>
    <div class="card-actions">
      ${p.builtin
        ? `<span class="hint">由 dsh 安装本身提供，受保护</span>`
        : `<button class="btn warn small" data-act="remove">卸载</button>`}
    </div>
  </div>`;
}

function bindInstalledEvents() {
  document.querySelectorAll('#installedGrid .card').forEach((card) => {
    const name = card.dataset.name;
    const item = state.installed.find((p) => p.name === name);
    card.querySelector('[data-act="toggle"]')?.addEventListener('change', (e) => {
      togglePlugin(item, e.target.checked, e.target);
    });
    card.querySelector('[data-act="remove"]')?.addEventListener('click', () => askRemove(item));
  });
}

async function togglePlugin(item, enabled, inputEl) {
  const profile = getSettings().profile || 'web';
  inputEl.disabled = true;
  try {
    const r = await fetch('/api/plugin/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ package: item.name, profile, enabled }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    item.enabled = enabled;
    renderInstalled();
    toast(`${enabled ? '已启用' : '已禁用'} ${item.name}（重启 dsh web 后生效）`, 'ok');
  } catch (e) {
    inputEl.checked = !enabled;
    inputEl.disabled = false;
    toast('操作失败：' + e.message, 'err');
  }
}

// ---------- AI 简介 ----------
function aiConfigReady() {
  const s = getSettings();
  return !!s.apiKey;
}

async function genOne(item) {
  if (!aiConfigReady()) { toast('请先在设置中填写 API Key', 'err'); openSettings(); return; }
  state.ai.set(item.name, { pending: true });
  render();
  await describeBatch([item]);
}

async function genBatch() {
  if (!aiConfigReady()) { toast('请先在设置中填写 API Key', 'err'); openSettings(); return; }
  const list = visibleItems().filter((i) => !state.ai.get(i.name)?.intro);
  if (!list.length) { toast('当前列表都已有 AI 简介', ''); return; }
  const btn = $('btnBatchAi');
  btn.disabled = true;
  btn.textContent = '生成中…';
  // 分批，每批 8 个
  for (let i = 0; i < list.length; i += 8) {
    const chunk = list.slice(i, i + 8);
    chunk.forEach((c) => state.ai.set(c.name, { pending: true }));
    render();
    await describeBatch(chunk);
  }
  btn.disabled = false;
  btn.textContent = '✦ 为当前列表批量生成 AI 简介';
  toast('AI 简介生成完成', 'ok');
}

async function describeBatch(items) {
  const s = getSettings();
  const payload = {
    packages: items.map((i) => ({ name: i.name, description: i.description, keywords: i.keywords })),
    provider: s.provider,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    model: s.model,
  };
  try {
    const r = await fetch('/api/ai/describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    for (const res of data.results) {
      state.ai.set(res.name, { intro: res.intro, tags: res.tags });
    }
    // 未返回的标记失败
    for (const it of items) {
      const got = data.results.find((x) => x.name === it.name && x.intro);
      if (!got) state.ai.set(it.name, { error: '模型未返回该插件' });
    }
  } catch (e) {
    for (const it of items) state.ai.set(it.name, { error: e.message });
  }
  render();
}

// ---------- 设置面板 ----------
function openSettings() {
  const s = getSettings();
  populateProfiles();
  $('setProfile').value = s.profile;
  $('setWebPort').value = s.webPort;
  $('setProvider').value = s.provider;
  $('setBaseUrl').value = s.baseUrl;
  $('setModel').value = s.model;
  $('setApiKey').value = s.apiKey;
  $('settingsOverlay').classList.remove('hidden');
}

function applyProviderDefaults() {
  const p = $('setProvider').value;
  if (p === 'deepseek') {
    $('setBaseUrl').value = 'https://api.deepseek.com/v1';
    $('setModel').value = 'deepseek-chat';
  }
}

function saveSettingsFromForm() {
  const s = {
    profile: $('setProfile').value || 'web',
    webPort: Number($('setWebPort').value) || 3080,
    provider: $('setProvider').value,
    baseUrl: $('setBaseUrl').value.trim() || 'https://api.deepseek.com/v1',
    model: $('setModel').value.trim() || 'deepseek-chat',
    apiKey: $('setApiKey').value.trim(),
  };
  saveSettings(s);
  $('settingsOverlay').classList.add('hidden');
  render();
  refreshWebStatus();
  if (state.view === 'installed') loadInstalled();
  toast('设置已保存', 'ok');
}

// ---------- 绑定 ----------
function init() {
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view))
  );
  $('btnRefreshInstalled').addEventListener('click', loadInstalled);
  $('btnRestartWeb').addEventListener('click', askRestart);
  $('btnLoad').addEventListener('click', () => loadPlugins(true));
  $('btnMore').addEventListener('click', () => { state.page += 1; loadPlugins(false); });
  $('filterText').addEventListener('input', render);
  $('sortBy').addEventListener('change', render);
  $('sizeSel').addEventListener('change', () => loadPlugins(true));
  $('btnBatchAi').addEventListener('click', genBatch);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', () => $('settingsOverlay').classList.add('hidden'));
  $('setProvider').addEventListener('change', applyProviderDefaults);
  $('btnSaveSettings').addEventListener('click', saveSettingsFromForm);
  $('btnInstallPnpm').addEventListener('click', installPnpm);
  $('btnDoConfirm').addEventListener('click', doDeploy);
  $('btnCancelConfirm').addEventListener('click', () => $('confirmOverlay').classList.add('hidden'));
  $('btnCloseLog').addEventListener('click', () => $('logOverlay').classList.add('hidden'));

  loadStatus();
  setInterval(refreshWebStatus, 5000);
}

document.addEventListener('DOMContentLoaded', init);
