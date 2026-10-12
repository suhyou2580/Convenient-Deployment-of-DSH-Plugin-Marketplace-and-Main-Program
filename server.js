// DSH 插件一键部署器 — 本地后端
// 零依赖：仅用 Node 内置模块。职责：静态托管 + 代理 npm 搜索 + 执行 dsh 插件安装 + AI 简介。
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3210;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DSH_PROFILES_DIR = path.join(os.homedir(), '.dsh', 'profiles');

// ---------- 工具 ----------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- 状态探测 ----------

// Windows 上 dsh / npm / pnpm 都是 .cmd 批处理包装，必须经 cmd.exe 才能执行。
// 这里显式调用 cmd.exe 而不是 shell:true——后者与 args 数组同用会触发 Node 的
// DEP0190（args 未经转义、直接空格拼接）警告。调用点的参数均已白名单/格式校验。
function spawnCommand(cmd, args, opts = {}) {
  const options = { windowsHide: true, ...opts };
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/c', cmd, ...args], options);
  }
  return spawn(cmd, args, options);
}

function execCapture(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawnCommand(cmd, args);
    const timer = setTimeout(() => {
      if (!done) child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => {
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, out: '' });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim() });
    });
  });
}

function listProfiles() {
  try {
    return fs
      .readdirSync(DSH_PROFILES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// ---------- Profile 清单（已安装/启用状态） ----------

function profileDir(profile) {
  return path.join(DSH_PROFILES_DIR, profile);
}

function readProfileManifest(profile) {
  const file = path.join(profileDir(profile), 'package.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, json };
}

// 原子写：先写临时文件再 rename 覆盖，避免 dsh 读到半截文件
function writeProfileManifest(file, json) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// 已安装 = dependencies 的键；已启用 = 出现在 dsh.profile.bundles 中。
// 内置 bundle（由 dsh 安装本身提供，如 dsh-base/dsh-web-app）只在 bundles 里、不在 dependencies 里 → 受保护、不可卸载。
function listInstalled(profile) {
  const { json } = readProfileManifest(profile);
  const deps = json.dependencies || {};
  const bundles = json.dsh?.profile?.bundles || [];
  const names = new Set([...Object.keys(deps), ...bundles]);
  const plugins = [...names].map((name) => {
    const installed = Object.prototype.hasOwnProperty.call(deps, name);
    const enabled = bundles.includes(name);
    return {
      name,
      version: installed ? deps[name] : null,
      installed,
      enabled,
      builtin: enabled && !installed,
    };
  });
  plugins.sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
  return { profile, plugins };
}

function setBundleEnabled(profile, name, enabled) {
  const { file, json } = readProfileManifest(profile);
  const deps = json.dependencies || {};
  if (!Object.prototype.hasOwnProperty.call(deps, name)) {
    throw new Error('只能启用/禁用已安装的插件（内置 bundle 不可更改）');
  }
  json.dsh = json.dsh || {};
  json.dsh.profile = json.dsh.profile || {};
  let bundles = Array.isArray(json.dsh.profile.bundles) ? json.dsh.profile.bundles : [];
  const has = bundles.includes(name);
  if (enabled && !has) bundles = [...bundles, name];
  else if (!enabled && has) bundles = bundles.filter((n) => n !== name);
  json.dsh.profile.bundles = bundles;
  writeProfileManifest(file, json);
  return { profile, name, enabled, bundles };
}

function assertRemovable(profile, name) {
  const { json } = readProfileManifest(profile);
  const deps = json.dependencies || {};
  if (!Object.prototype.hasOwnProperty.call(deps, name)) {
    throw new Error('只能卸载已安装的插件（内置 bundle 不可卸载）');
  }
}

async function getStatus() {
  const [dsh, pnpm] = await Promise.all([
    execCapture('dsh', ['--version']),
    execCapture('pnpm', ['--version']),
  ]);
  return {
    dshVersion: dsh.ok ? dsh.out : null,
    dshInstalled: dsh.ok,
    pnpmInstalled: pnpm.ok,
    pnpmVersion: pnpm.ok ? pnpm.out : null,
    profiles: listProfiles(),
    profilesDir: DSH_PROFILES_DIR,
  };
}

// ---------- npm 搜索代理 ----------

function httpGetJson(urlStr) {
  return new Promise((resolve, reject) => {
    const mod = urlStr.startsWith('https:') ? https : http;
    const req = mod.get(
      urlStr,
      { headers: { 'User-Agent': 'dsh-plugin-deployer/1.0', Accept: 'application/json' } },
      (r) => {
        let data = '';
        r.on('data', (c) => (data += c));
        r.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`bad JSON from upstream (${r.statusCode})`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('upstream timeout')));
  });
}

function normalizeSearch(data) {
  const objects = Array.isArray(data?.objects) ? data.objects : [];
  const items = objects.map((o) => {
    const p = o.package || {};
    const links = p.links || {};
    return {
      name: p.name,
      version: p.version,
      description: p.description || '',
      keywords: Array.isArray(p.keywords) ? p.keywords : [],
      date: p.date || null,
      publisher: p.publisher?.username || p.publisher?.name || null,
      monthlyDownloads: o.downloads?.monthly ?? null,
      weeklyDownloads: o.downloads?.weekly ?? null,
      links: {
        npm: links.npm || `https://www.npmjs.com/package/${p.name}`,
        homepage: links.homepage || null,
        repository: links.repository || null,
      },
    };
  });
  return { total: data?.total ?? items.length, items };
}

async function handleSearch(query) {
  const q = (query.get('q') || '').trim();
  const page = Math.max(0, Number(query.get('page')) || 0);
  const size = Math.min(100, Math.max(1, Number(query.get('size')) || 24));

  // 默认按 dsh-plugin 关键词；附加词收窄结果
  const text = q ? `keywords:dsh-plugin ${q}` : 'keywords:dsh-plugin';
  const params = new URLSearchParams({ text, size: String(size), from: String(page * size) });
  const url = `https://registry.npmjs.org/-/v1/search?${params.toString()}`;
  const data = await httpGetJson(url);
  return normalizeSearch(data);
}

// ---------- 安装执行（SSE 流式） ----------

const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

function validatePackageName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 214) return false;
  if (/\s/.test(name)) return false;
  return NPM_NAME_RE.test(name);
}

function validateProfile(profile) {
  if (typeof profile !== 'string') return false;
  if (!PROFILE_NAME_RE.test(profile)) return false;
  // 必须命中已存在的 profile 白名单
  return listProfiles().includes(profile);
}

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  return (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

// cmd + args 已经过严格校验（包名 npm 命名规则 / profile 白名单）。
function streamCommand(res, { label, cmd, args }) {
  const emit = openSse(res);
  emit({ type: 'start', label, command: [cmd, ...args].join(' ') });

  const child = spawnCommand(cmd, args);
  let finished = false;

  const onData = (buf) => emit({ type: 'out', text: buf.toString('utf8') });
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    if (finished) return;
    finished = true;
    emit({ type: 'error', message: `无法启动进程: ${err.message}` });
    emit({ type: 'done', code: -1 });
    res.end();
  });

  child.on('close', (code) => {
    if (finished) return;
    finished = true;
    emit({ type: 'done', code: code ?? -1 });
    res.end();
  });

  // 客户端断开时终止子进程
  res.on('close', () => {
    if (!finished) child.kill();
  });
}

// ---------- AI 简介（OpenAI 兼容） ----------

function normalizeChatUrl(base) {
  const b = (base || 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
}

function httpPostJson(urlStr, headers, bodyObj, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj);
    const mod = urlStr.startsWith('https:') ? https : http;
    const u = new URL(urlStr);
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
      },
      (r) => {
        let data = '';
        r.on('data', (c) => (data += c));
        r.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            return reject(new Error(`AI 接口返回非 JSON (HTTP ${r.statusCode}): ${data.slice(0, 300)}`));
          }
          if (r.statusCode >= 400) {
            const msg = parsed?.error?.message || parsed?.message || `HTTP ${r.statusCode}`;
            return reject(new Error(`AI 接口错误: ${msg}`));
          }
          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('AI 接口超时')));
    req.write(payload);
    req.end();
  });
}

function extractJsonArray(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function handleAiDescribe(body) {
  const { packages: pkgs, baseUrl, apiKey, model } = body || {};
  if (!Array.isArray(pkgs) || pkgs.length === 0) throw new Error('缺少 packages');
  if (!apiKey) throw new Error('缺少 API Key（请在设置中填写）');
  const batch = pkgs.slice(0, 8);

  const sys =
    '你是 DeepSeek Harness (dsh) 插件生态的专家。请为给定的 dsh 插件逐个撰写简洁的中文功能介绍。' +
    '要求：每个 plugin 输出一个对象，字段 name（原样回传插件名）、intro（1~2 句中文介绍，说清它做什么、"为谁解决什么问题"，不要复读英文原名）、' +
    'tags（2~4 个中文分类标签，如 "界面/主题"、"费用统计"、"消息接入"、"开发工具"）。' +
    '只输出 JSON 数组，不要任何解释文字。';

  const userContent = batch
    .map((p) => `- name: ${p.name}\n  description: ${(p.description || '').slice(0, 500) || '(无)'}\n  keywords: ${(p.keywords || []).join(', ')}`)
    .join('\n');

  const url = normalizeChatUrl(baseUrl);
  const resp = await httpPostJson(
    url,
    { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    {
      model: model || 'deepseek-chat',
      temperature: 0.4,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userContent },
      ],
    }
  );

  const content = resp?.choices?.[0]?.message?.content || '';
  const arr = extractJsonArray(content);
  if (!arr) throw new Error(`无法解析 AI 返回内容: ${content.slice(0, 200)}`);

  const byName = new Map();
  for (const item of arr) {
    if (item && item.name) byName.set(item.name, item);
  }
  const results = batch.map((p) => {
    const hit = byName.get(p.name);
    return {
      name: p.name,
      intro: hit?.intro || null,
      tags: Array.isArray(hit?.tags) ? hit.tags : [],
    };
  });
  return { results };
}

// ---------- 重启 dsh web ----------

const DSH_WEB_PORT_DEFAULT = 3080;

// dsh web 启动时会把带 access token 的访问 URL 打印到标准输出。我们把它重定向到文件，
// 好在保持「分离启动」的前提下也能读到这个 URL——用管道会随本应用退出而关闭，子进程写会失败。
const DSH_WEB_LOG = path.join(os.tmpdir(), 'dsh-plugin-deployer-web.log');

let dshWebUrl = null; // 最近一次由本应用启动得到的、带 token 的访问 URL
let dshWebUrlPort = null; // 上面这个 URL 对应的端口（换端口或外部启动时失效）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePort(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

// 找出监听指定端口的进程 PID（Windows: netstat -ano）
async function findListeningPids(port) {
  const { out } = await execCapture('netstat', ['-ano'], 15000);
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[1] || '';
    const pid = parts[parts.length - 1];
    if (local.endsWith(`:${port}`) && /^\d+$/.test(pid)) pids.add(Number(pid));
  }
  return [...pids];
}

function killPid(pid) {
  if (process.platform === 'win32') return execCapture('taskkill', ['/PID', String(pid), '/F'], 15000);
  return execCapture('kill', ['-9', String(pid)], 15000);
}

// 分离启动，令 dsh web 独立于本应用存活（本应用退出它也不受影响），
// 同时捕获它打印的、带 access token 的访问 URL。
//
// 为什么要绕开 `dsh`（.cmd 包装）直接跑 node 入口：Windows 上用 DETACHED_PROCESS 启动时，
// stdio 传出去的句柄不会被继承到「孙进程」（cmd.exe 的子进程），重定向拿不到任何输出。
// 直接 spawn 一个可执行文件（node）则正常。回退路径（解析不到入口时）仍有功能，只是读不到 token。
let dshEntryCache; // undefined=尚未探测；null=未找到
async function resolveDshEntry() {
  if (dshEntryCache !== undefined) return dshEntryCache;
  dshEntryCache = null;
  if (process.platform === 'win32') {
    const { out } = await execCapture('where', ['dsh'], 8000);
    const cmdPath = out.split(/\r?\n/).map((s) => s.trim()).find((p) => /\.cmd$/i.test(p));
    if (cmdPath) {
      // 与 npm 生成的 dsh.cmd 一致：node <npm 全局>/node_modules/@deepseek-ai/dsh/lib/bin.js
      const entry = path.join(path.dirname(cmdPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(entry)) dshEntryCache = entry;
    }
  }
  return dshEntryCache;
}

async function startDshWebDetached() {
  const entry = await resolveDshEntry();
  if (entry) {
    const logFd = fs.openSync(DSH_WEB_LOG, 'w'); // 截断：避免匹配到上一次运行的旧 token
    const child = spawn(process.execPath, [entry, 'web'], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    fs.closeSync(logFd); // 子进程已继承该 fd，父进程这份可关
    child.unref();
    return child.pid;
  }
  const child = spawnCommand('dsh', ['web'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

// 从 dsh web 的输出里解析带 token 的访问 URL（形如 http://127.0.0.1:3080/?token=xxxx）。
async function captureWebUrl(port, timeoutMs) {
  const re = new RegExp(`https?://\\S*?:${port}/\\S*?token=[\\w-]+`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const m = fs.readFileSync(DSH_WEB_LOG, 'utf8').match(re);
      if (m) return m[0];
    } catch {
      /* 文件尚未生成，继续等 */
    }
    await sleep(300);
  }
  return null;
}

async function waitForPort(port, wantListening, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = await findListeningPids(port);
    if (wantListening ? pids.length > 0 : pids.length === 0) return true;
    await sleep(500);
  }
  return false;
}

async function handleRestartWeb(res, port) {
  const emit = openSse(res);
  try {
    emit({ type: 'out', text: `检查端口 ${port} 上运行的 dsh web…\n` });
    const pids = await findListeningPids(port);
    if (pids.length === 0) {
      emit({ type: 'out', text: `未发现监听 ${port} 的进程，将直接启动 dsh web。\n` });
    } else {
      emit({ type: 'out', text: `发现 PID: ${pids.join(', ')}，正在停止…\n` });
      for (const pid of pids) {
        const r = await killPid(pid);
        emit({ type: 'out', text: `  taskkill ${pid}: ${r.out || (r.ok ? '已终止' : '失败')}\n` });
      }
      const freed = await waitForPort(port, false, 15000);
      emit({ type: 'out', text: freed ? '端口已释放。\n' : '警告：端口仍被占用，继续尝试启动。\n' });
    }

    emit({ type: 'out', text: '正在启动 dsh web（默认会自动打开浏览器）…\n' });
    dshWebUrl = null;
    dshWebUrlPort = null;
    await startDshWebDetached();

    const up = await waitForPort(port, true, 60000);
    if (up) {
      // 端口已监听时 dsh 通常已把带 token 的 URL 打印出来，短窗口内读取即可
      const captured = await captureWebUrl(port, 5000);
      dshWebUrl = captured;
      dshWebUrlPort = captured ? port : null;
      if (captured) {
        emit({ type: 'out', text: `已捕获本体访问地址（含 token）：${captured}\n` });
      } else {
        emit({
          type: 'out',
          text: '未捕获到带 token 的地址。若打开本体提示需要鉴权，请复制 dsh web 控制台打印的带 ?token= 的完整 URL 打开一次（之后 30 天内普通链接也可用）。\n',
        });
      }
      emit({ type: 'done', code: 0, url: captured || `http://127.0.0.1:${port}/`, authenticated: !!captured });
    } else {
      emit({ type: 'out', text: '启动后 60 秒内未检测到端口监听。\n' });
      emit({ type: 'done', code: -1 });
    }
  } catch (e) {
    emit({ type: 'error', message: e.message });
    emit({ type: 'done', code: -1 });
  }
  res.end();
}

// ---------- 静态文件 ----------

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const { pathname } = url;

  try {
    if (req.method === 'GET' && pathname === '/api/status') {
      return sendJson(res, 200, await getStatus());
    }

    if (req.method === 'GET' && pathname === '/api/web-status') {
      const port = parsePort(url.searchParams.get('port') ?? DSH_WEB_PORT_DEFAULT);
      if (port === null) return sendJson(res, 400, { error: '非法的端口' });
      const pids = await findListeningPids(port);
      const running = pids.length > 0;
      // 仅当本体在运行、且是本应用在相同端口上启动的，才提供带 token 的 URL
      const webUrl = running && dshWebUrl && dshWebUrlPort === port ? dshWebUrl : null;
      return sendJson(res, 200, { port, running, pids, url: webUrl });
    }

    if (req.method === 'GET' && pathname === '/api/search') {
      return sendJson(res, 200, await handleSearch(url.searchParams));
    }

    if (req.method === 'POST' && pathname === '/api/deploy') {
      const body = await readBody(req);
      const pkg = body.package;
      const profile = body.profile;
      if (!validatePackageName(pkg)) return sendJson(res, 400, { error: '非法的包名' });
      if (!validateProfile(profile)) return sendJson(res, 400, { error: '非法的 profile（未在 ~/.dsh/profiles 中找到）' });
      return streamCommand(res, { label: `安装 ${pkg}`, cmd: 'dsh', args: ['plugin', '--profile', profile, 'add', pkg] });
    }

    if (req.method === 'POST' && pathname === '/api/deploy-pnpm') {
      return streamCommand(res, { label: '安装 pnpm', cmd: 'npm', args: ['install', '-g', 'pnpm'] });
    }

    if (req.method === 'POST' && pathname === '/api/restart-web') {
      const body = await readBody(req);
      const port = parsePort(body.port ?? DSH_WEB_PORT_DEFAULT);
      if (port === null) return sendJson(res, 400, { error: '非法的端口' });
      return handleRestartWeb(res, port);
    }

    if (req.method === 'GET' && pathname === '/api/installed') {
      const profile = url.searchParams.get('profile') || 'web';
      if (!validateProfile(profile)) return sendJson(res, 400, { error: '非法的 profile' });
      try {
        return sendJson(res, 200, listInstalled(profile));
      } catch (e) {
        return sendJson(res, 404, { error: `无法读取 profile 清单: ${e.message}` });
      }
    }

    if (req.method === 'POST' && pathname === '/api/plugin/toggle') {
      const body = await readBody(req);
      const { package: pkg, profile, enabled } = body;
      if (!validatePackageName(pkg)) return sendJson(res, 400, { error: '非法的包名' });
      if (!validateProfile(profile)) return sendJson(res, 400, { error: '非法的 profile' });
      try {
        const r = setBundleEnabled(profile, pkg, !!enabled);
        return sendJson(res, 200, { ok: true, ...r, restartRequired: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/plugin/remove') {
      const body = await readBody(req);
      const { package: pkg, profile } = body;
      if (!validatePackageName(pkg)) return sendJson(res, 400, { error: '非法的包名' });
      if (!validateProfile(profile)) return sendJson(res, 400, { error: '非法的 profile' });
      try {
        assertRemovable(profile, pkg);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      return streamCommand(res, { label: `卸载 ${pkg}`, cmd: 'dsh', args: ['plugin', '--profile', profile, 'remove', pkg] });
    }

    if (req.method === 'POST' && pathname === '/api/ai/describe') {
      const body = await readBody(req);
      return sendJson(res, 200, await handleAiDescribe(body));
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    res.writeHead(405);
    res.end('Method Not Allowed');
  } catch (err) {
    if (res.headersSent) return res.end();
    sendJson(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`DSH 插件一键部署器: http://${HOST}:${PORT}`);
  console.log(`Profiles 目录: ${DSH_PROFILES_DIR}`);
});
