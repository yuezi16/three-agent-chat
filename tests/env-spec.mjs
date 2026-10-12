// T-025 单一职责探针①：宿主子进程服务到底会不会把 env 传给子进程？
// 只用 node 自己打印环境变量（source: 'raw'），不起 CLI、不烧一分钱。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHandler, Config } from '../plugin/index.js';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
let stderrText = '';
// 这里复刻宿主 dsh-subprocess-local 的适配器形状，并且**故意按宿主文档的样子把 env 交给 spawn**。
// 关键点：探针把 spec.env 直接当整份环境交给 spawn（=「只给这几项」），这正是要验的事。
const subprocess = { spawn(spec) {
  assert.match(spec.argv[0], /node\.exe$/i, '只允许 node.exe 当探针');
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env === undefined ? process.env : spec.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; let lossy = false, killing;
  for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => { buffers[name] = Buffer.concat([buffers[name], chunk]); if (name === 'stderr') stderrText += chunk.toString('utf8'); });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
  const terminate = () => { if (killing || !alive(child.pid)) return; killing = new Promise((resolve, reject) => {
    const k = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    k.once('error', reject); k.once('close', code => code === 0 ? resolve() : reject(new Error(`taskkill ${code}`))); }); killing.catch(() => {}); };
  spec.signal.addEventListener('abort', terminate, { once: true });
  return { pid: child.pid, done, terminate,
    collected: Object.fromEntries(['stdout', 'stderr'].map(name => [name, { readFrom: offset => ({ text: buffers[name].subarray(offset).toString('utf8'), nextOffset: buffers[name].length, lossy }) }])),
    async waitForExit() { await done; if (killing) await killing; return !alive(child.pid); } };
} };
const config = { cwd: resolve(here, '..'), graceMs: 500,
  env: { HTTP_PROXY: 'http://127.0.0.1:10808', HTTPS_PROXY: 'http://127.0.0.1:10808', NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' },
  members: { probe: { displayName: '探针', source: 'raw', exe: process.execPath,
    argsTemplate: [resolve(here, 'env-dump.js')] } } };
const ctx = { get: key => key === 'connection' ? { requestRejection: () => undefined } : subprocess };
// 成员白名单来自插件自己的 Config（HTTP 不能加成员），所以探针这一格挂到 Config.members 上。
Object.defineProperty(Config.members, 'probe', { value: config.members.probe, configurable: true, enumerable: true });
const api = createHandler(ctx, config);
const req = Readable.from([JSON.stringify({ member: 'probe', instruction: 'x' })]);
req.method = 'POST'; req.url = '/api/three-agent-chat/ask';
const res = new EventEmitter(); res.writeHead = code => { res.code = code; }; res.end = text => { res.body = JSON.parse(text); res.writableEnded = true; };
await api.handler(req, res);
console.log('HTTP', res.code);
console.log('子进程 stdout 原文：');
console.log(JSON.stringify(res.body.text));
console.log('子进程 stderr 原文（探针自己抓的）：', JSON.stringify(stderrText));
console.log('status =', res.body.status, '｜ exitCode =', res.body.exitCode);
const sawProxy = res.body.text.includes('HTTP_PROXY=[http://127.0.0.1:10808]');
const sawNoProxy = res.body.text.includes('NO_PROXY=[127.0.0.1,localhost,::1]');
console.log(sawProxy && sawNoProxy ? 'ENV-SPEC PASS：宿主把代理变量原样传给了子进程' : 'ENV-SPEC FAIL：代理变量没传到位');
process.exitCode = sawProxy && sawNoProxy ? 0 : 1;
await api.dispose();
