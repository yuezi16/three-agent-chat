// T-025 调试探针：只跑「先起一轮 sleep、再 dispose、看那一位能不能重新点名」这一段，定位泄漏点。
// 不许起真 CLI：断言 argv[0] 必须在白名单里、且不是真 codex/agy。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHandler, MAX_BYTES } from '../plugin/index.js';
const dir = fileURLToPath(new URL('.', import.meta.url));
const stub = fileURLToPath(new URL('../plugin/stubs/fake-member.js', import.meta.url));
let spawns = 0;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
const subprocess = { spawn(spec) {
  assert.equal(spec.argv[0], process.execPath, 'REAL CLI FORBIDDEN');
  assert.equal(spec.argv[1], stub, 'ONLY FAKE MEMBER ALLOWED');
  spawns++;
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; let lossy = false, killing;
  for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
    const remaining = MAX_BYTES - buffers[name].length;
    if (chunk.length > remaining) lossy = true;
    buffers[name] = Buffer.concat([buffers[name], chunk.subarray(0, remaining)]);
  });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
  const terminate = () => {
    if (killing || !alive(child.pid)) return;
    killing = new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.once('error', reject); killer.once('close', code => code === 0 ? resolve() : reject(new Error(`taskkill exit ${code}`)));
    });
    killing.catch(() => {});
  };
  spec.signal.addEventListener('abort', terminate, { once: true });
  return { pid: child.pid, done, terminate,
    collected: Object.fromEntries(['stdout', 'stderr'].map(name => [name, { readFrom: offset => ({ text: buffers[name].subarray(offset).toString('utf8'), nextOffset: buffers[name].length, lossy }) }])),
    async waitForExit() { await done; if (killing) await killing; return !alive(child.pid); } };
} };
const config = { cwd: dir, members: { longmei: { exe: process.execPath, argsTemplate: [stub, '{instruction}'] }, cat: { exe: process.execPath, argsTemplate: [stub, '{instruction}'] } } };
const ctx = { get: key => key === 'connection' ? { requestRejection: () => undefined } : subprocess };
const api = createHandler(ctx, config);
function ask(body) {
  const req = Readable.from([JSON.stringify(body)]); req.method = 'POST'; req.url = '/api/three-agent-chat/ask';
  const res = new EventEmitter(); res.writeHead = code => { res.code = code; }; res.end = text => { res.body = JSON.parse(text); res.writableEnded = true; };
  return api.handler(req, res).then(() => res);
}
const pending = ask({ member: 'longmei', instruction: 'sleep', requestId: 'dup' }); await delay(200);
console.log('第一步：同 requestId 再来一次 →', (await ask({ member: 'longmei', instruction: 'x', requestId: 'dup' })).code);
await api.dispose();
console.log('第二步：dispose 之后原来那轮的状态 →', (await pending).body.status, '（起过进程次数', spawns, '）');
await delay(300);
const again = await ask({ member: 'longmei', instruction: '假程序原话' });
console.log('第三步：dispose 之后再点名同一位 →', again.body.status, JSON.stringify(again.body.error));
console.log(again.body.status === 'ok' ? 'LEAK-FIX PASS：dispose 之后那一格能重新点名' : 'LEAK STILL THERE：那一格被卡住了');
process.exitCode = again.body.status === 'ok' ? 0 : 1;
