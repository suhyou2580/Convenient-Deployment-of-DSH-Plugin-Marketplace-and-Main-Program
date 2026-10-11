// DSH 插件一键部署器 — 自检程序（零依赖）
// 逐项检查运行环境与项目文件，把发现的问题列出来。
// 退出码：0 = 无严重问题；1 = 存在「错误」级问题（会阻止正常启动）；2 = 自检自身异常。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3210;
const DSH_PROFILES_DIR = path.join(os.homedir(), '.dsh', 'profiles');

const results = [];
const ok = (name, detail = '') => results.push({ level: 'ok', name, detail });
const warn = (name, detail = '') => results.push({ level: 'warn', name, detail });
const error = (name, detail = '') => results.push({ level: 'error', name, detail });

// ---------- 进程工具 ----------

// Windows 上 dsh / pnpm 等是 .cmd 包装，必须经 cmd.exe 执行。
function spawnCommand(cmd, args, opts = {}) {
  const options = { windowsHide: true, ...opts };
  if (process.platform === 'win32') return spawn('cmd.exe', ['/d', '/c', cmd, ...args], options);
  return spawn(cmd, args, options);
}

function run(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let child;
    try {
      child = spawnCommand(cmd, args);
    } catch {
      return resolve({ ok: false, out: '' });
    }
    const timer = setTimeout(() => {
      if (!done) child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => {
      if (done) return;
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

function probeTcp(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'dsh-plugin-deployer/1.0', Accept: 'application/json' } }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => req.destroy());
  });
}

// ---------- 各项检查 ----------

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok('Node.js 版本', `v${process.versions.node}`);
  else error('Node.js 版本过低', `当前 v${process.versions.node}，需 >= 18（本项目使用 ES Module）`);
}

function checkFiles() {
  const required = ['package.json', 'server.js', 'public/index.html', 'public/app.js', 'public/style.css'];
  const missing = required.filter((rel) => !fs.existsSync(path.join(__dirname, rel)));
  if (!missing.length) ok('必需文件齐全', `${required.length} 个`);
  else for (const m of missing) error(`缺少文件：${m}`, '请从仓库重新获取该文件');
}

function checkPackage() {
  const p = path.join(__dirname, 'package.json');
  if (!fs.existsSync(p)) return; // 已由 checkFiles 报告
  try {
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (pkg.type !== 'module') warn('package.json 未声明 ES Module', '建议添加 "type": "module"');
    else ok('package.json 可解析');
  } catch (e) {
    error('package.json 无法解析', e.message);
  }
}

// Windows 批处理必须是 CRLF 换行：LF 会让 cmd.exe 解析错位，
// 叠加中文多字节字符后整份脚本会被拆散，导致 node server.js 根本没被执行（即“启动失败”）。
function checkBats() {
  let bats = [];
  try {
    bats = fs.readdirSync(__dirname).filter((f) => f.toLowerCase().endsWith('.bat'));
  } catch {
    /* ignore */
  }
  if (!bats.length) {
    warn('未找到 .bat 启动脚本', '若通过 npm start 启动可忽略');
    return;
  }
  for (const f of bats) {
    const buf = fs.readFileSync(path.join(__dirname, f));
    let loneLf = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a && buf[i - 1] !== 0x0d) loneLf++;
    }
    if (loneLf > 0) {
      error(`换行符错误：${f}`, `含 ${loneLf} 处 LF（Unix）换行。Windows 批处理必须用 CRLF，否则 cmd 解析错乱、无法启动。请用编辑器“另存为 CRLF/Windows 换行”后重试`);
    } else {
      ok(`换行符：${f}`, 'CRLF');
    }
  }
}

function checkProfiles() {
  if (!fs.existsSync(DSH_PROFILES_DIR)) {
    warn('未找到 profiles 目录', `${DSH_PROFILES_DIR}（先运行一次 dsh 生成）`);
    return;
  }
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(DSH_PROFILES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (e) {
    error('无法读取 profiles 目录', e.message);
    return;
  }
  if (!dirs.length) {
    warn('profiles 目录为空', DSH_PROFILES_DIR);
    return;
  }
  ok('profiles 目录', `${dirs.length} 个：${dirs.join(', ')}`);
  for (const p of dirs) {
    const mf = path.join(DSH_PROFILES_DIR, p, 'package.json');
    if (!fs.existsSync(mf)) {
      warn(`profile「${p}」无 package.json`, mf);
      continue;
    }
    try {
      JSON.parse(fs.readFileSync(mf, 'utf8'));
      ok(`profile「${p}」清单正常`);
    } catch (e) {
      error(`profile「${p}」清单损坏`, e.message);
    }
  }
}

async function checkTools() {
  const [dsh, pnpm] = await Promise.all([run('dsh', ['--version']), run('pnpm', ['--version'])]);
  if (dsh.ok) ok('dsh 可用', dsh.out.split(/\r?\n/)[0] || '');
  else warn('未检测到 dsh', '安装插件需要 dsh 在 PATH 中；不在时只能浏览/搜索');
  if (pnpm.ok) ok('pnpm 可用', pnpm.out.split(/\r?\n/)[0] || '');
  else warn('未检测到 pnpm', 'dsh 安装插件依赖 pnpm；可在界面点「安装 pnpm」');
}

async function checkPort() {
  const open = await probeTcp(PORT);
  if (!open) {
    ok(`端口 ${PORT}`, '可用');
    return;
  }
  const status = await getJson(`http://127.0.0.1:${PORT}/api/status`, 3000);
  if (status && status.profilesDir) ok(`端口 ${PORT}`, '本程序已在运行，可直接访问');
  else error(`端口 ${PORT} 被占用`, '被其它程序占用，服务将无法启动；可设环境变量换端口，如 set PORT=3211');
}

async function checkRegistry() {
  const data = await getJson('https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=1', 6000);
  if (data && Array.isArray(data.objects)) ok('npm registry 可达', '插件搜索正常');
  else warn('npm registry 不可达', '搜索/安装插件可能失败，请检查网络或代理');
}

// ---------- 主流程 ----------

const MARKS = { ok: '[正常]', warn: '[警告]', error: '[错误]' };

async function main() {
  console.log('DSH 插件一键部署器 · 自检');
  console.log('='.repeat(44));
  console.log('');

  checkNode();
  checkFiles();
  checkPackage();
  checkBats();
  checkProfiles();
  await checkTools();
  await checkPort();
  await checkRegistry();

  for (const r of results) {
    console.log(`  ${MARKS[r.level]} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }

  const problems = results.filter((r) => r.level !== 'ok');
  const errs = problems.filter((r) => r.level === 'error');
  const warns = problems.filter((r) => r.level === 'warn');

  console.log('');
  console.log('-'.repeat(44));
  if (!problems.length) {
    console.log('自检通过，未发现问题。');
    process.exit(0);
  }
  console.log(`发现 ${errs.length} 个错误、${warns.length} 个警告：`);
  console.log('');
  problems.forEach((r, i) => {
    console.log(`  ${i + 1}. ${MARKS[r.level]} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  });
  console.log('');
  process.exit(errs.length ? 1 : 0);
}

main().catch((e) => {
  console.error('自检程序自身出错：' + (e && e.message));
  process.exit(2);
});
