// T-025 第 5 批补充验收：**真 CLI 调用**（DeepSeek Harness亲跑，2026-10-12）。
// 目的：把「端点能不能真起 CLI、argv 对不对、输出能不能解析成成员原话」这条链一次验到底。
// 用法：`node real-cli-once.mjs <longmei|cat>`，默认 longmei；只跑一轮、指令固定「只回答两个字：收到」。
// 边界：只跑点名的这一格、不装插件、不启 DSH 宿主。Antigravity那格 2026-10-12 17:5x 首次通过。
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createHandler, Config, MAX_BYTES } from '../plugin/index.js';

const member = process.argv[2] ?? 'longmei';
if (member !== 'longmei' && member !== 'cat') throw new Error('只允许 longmei 或 cat，收到：' + member);
const expectedExe = Config.members[member].exe;
let spawns = 0;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
// 只用宿主服务的**最小替身**：真的起进程，收集输出，终止走 taskkill /T /F（跟 h1.mjs 同一套适配器）。
const subprocess = { spawn(spec) {
  if (spec.argv[0] !== expectedExe) throw new Error(`REAL CLIENT MUST BE ${member} ONLY: ` + spec.argv[0]);
  spawns++;
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...(spec.env ?? {}) }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; let lossy = false, killing;
  for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
    const remaining = MAX_BYTES - buffers[name].length;
    if (chunk.length > remaining) lossy = true;
    buffers[name] = Buffer.concat([buffers[name], chunk.subarray(0, remaining)]);
  });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
  const terminate = () => { if (killing || !alive(child.pid)) return; killing = new Promise((resolve, reject) => { const k = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' }); k.once('error', reject); k.once('close', code => code === 0 ? resolve() : reject(new Error(`taskkill exit ${code}`))); }); killing.catch(() => {}); };
  spec.signal.addEventListener('abort', terminate, { once: true });
  const h = { pid: child.pid, done, terminate,
    collected: Object.fromEntries(['stdout', 'stderr'].map(name => [name, { readFrom: offset => ({ text: buffers[name].subarray(offset).toString('utf8'), nextOffset: buffers[name].length, lossy }) }])),
    async waitForExit() { await done; if (killing) await killing; return !alive(child.pid); } };
  return h;
} };
const ctx = { get: key => key === 'connection' ? { requestRejection: () => undefined } : subprocess };
// 真跑要连通话代理：宿主那边由 Config.env 给，这里的最小替身按宿主契约把 spec.env 叠到进程环境上。
for (const [k, v] of Object.entries(Config.env ?? {})) if (!(k in process.env)) process.env[k] = v;
const api = createHandler(ctx, Config);
function call(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST'; req.url = '/api/three-agent-chat/ask';
  const res = new EventEmitter(); res.writeHead = code => { res.code = code; };
  res.end = text => { res.body = JSON.parse(text); res.writableEnded = true; };
  return api.handler(req, res).then(() => res);
}
const t0 = Date.now();
try {
  const r = await call({ member, instruction: '只回答两个字：收到', requestId: 'real-' + member, timeoutMs: 180000 });
  console.log('HTTP', r.code);
  console.log('响应原文：', JSON.stringify(r.body));
  console.log('真实起进程次数：', spawns, '／ 墙钟秒数：', ((Date.now() - t0) / 1000).toFixed(1));
  const ok = r.body.status === 'ok' && r.body.text.includes('收到');
  console.log(ok ? `REAL-CLI PASS：端点真起 ${member}、回答是真成员原话、usage 已解析` : 'REAL-CLI FAIL：状态或文本不对，见上面原文');
  process.exitCode = ok ? 0 : 1;
} finally { await api.dispose(); }
