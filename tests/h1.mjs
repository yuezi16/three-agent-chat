import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHandler, apply, Config, MAX_BYTES } from '../plugin/index.js';
const dir = fileURLToPath(new URL('.', import.meta.url));
const stub = fileURLToPath(new URL('../plugin/stubs/fake-member.js', import.meta.url));
const heartbeat = `${dir}heartbeat-${Date.now()}.log`;
let spawns = 0; const handles = []; let connection = { requestRejection: () => undefined };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
// Test adapter only: bounded collectors plus Windows taskkill /T /F.
// Production uses ctx.get('subprocess'), never this adapter.
const subprocess = { spawn(spec) {
  assert.equal(spec.argv[0], process.execPath, 'REAL CLI FORBIDDEN');
  assert.equal(spec.argv[1], stub, 'ONLY FAKE MEMBER ALLOWED');
  assert.equal(spec.stdio.stdout.maxBytes, MAX_BYTES);
  assert.equal(spec.stdio.stderr.maxBytes, MAX_BYTES);
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
  const h = { pid: child.pid, done, terminate,
    collected: Object.fromEntries(['stdout', 'stderr'].map(name => [name, { readFrom: offset => ({ text: buffers[name].subarray(offset).toString('utf8'), nextOffset: buffers[name].length, lossy }) }])),
    async waitForExit() { await done; if (killing) await killing; return !alive(child.pid); },
    size: () => buffers.stdout.length,
  };
  done.finally(() => spec.signal.removeEventListener('abort', terminate)).catch(() => {});
  handles.push(h); return h;
} };
const config = { cwd: dir, members: Object.fromEntries(['longmei', 'cat'].map(id => [id, { exe: process.execPath, argsTemplate: [stub, '{instruction}', heartbeat] }])) };
const ctx = { get: key => key === 'connection' ? connection : subprocess };
const api = createHandler(ctx, config);
function call(body, action = '', options = {}) {
  const req = Readable.from([options.raw ?? JSON.stringify(body)]);
  req.method = options.method ?? 'POST'; req.url = `/api/three-agent-chat/ask${action}`;
  if (options.noRead) req[Symbol.asyncIterator] = () => { throw new Error('AUTH READ BODY'); };
  const res = new EventEmitter(); res.writeHead = code => { res.code = code; };
  res.end = text => { res.body = JSON.parse(text); res.writableEnded = true; };
  return api.handler(req, res).then(() => res);
}
const ask = (instruction, extra = {}) => call({ member: 'longmei', instruction, ...extra });
async function treeStopped(label) {
  assert(existsSync(heartbeat));
  const before = readFileSync(heartbeat, 'utf8');
  const pids = [...new Set(before.trim().split('\n').map(Number))];
  assert(pids.length >= 2, 'parent AND child heartbeat required');
  assert(pids.every(pid => !alive(pid)), 'all heartbeat PIDs must be absent at response');
  await delay(150); assert.equal(readFileSync(heartbeat, 'utf8'), before);
  console.log(`PASS ${label}: parent+child absent; heartbeat unchanged; pids=${pids.join(',')}`);
}
try {
  let r = await ask('假程序原话', { requestId: 'normal' });
  console.log(`normal-result: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.status, 'ok'); assert.equal(r.body.text, '假程序原话'); assert(r.body.durationMs > 0);
  assert.deepEqual(r.body.usage, { inputTokens: 12, cachedTokens: 4, outputTokens: 3 });
  console.log(`PASS normal: ${JSON.stringify(r.body)}`);
  r = await ask('sleep', { timeoutMs: 1000 }); assert.equal(r.body.status, 'timeout'); await treeStopped('timeout');
  const pending = ask('sleep', { requestId: 'cancel-me' }); await delay(200);
  r = await call({ requestId: 'cancel-me' }, '?action=cancel'); assert.deepEqual(r.body, { cancelled: true });
  assert.equal((await pending).body.status, 'cancelled'); console.log(`PASS cancel: ${JSON.stringify(r.body)} original=cancelled`); await treeStopped('cancel');
  let before = spawns;
  r = await ask('x', { member: 'not-a-member' }); assert.equal(r.code, 400); assert.equal(r.body.code, 'bad-member');
  r = await ask('x'.repeat(15000)); assert.equal(r.code, 400); assert.equal(r.body.code, 'bad-instruction');
  r = await ask('x', { member: '__proto__' }); assert.equal(r.code, 400); assert.equal(spawns, before);
  const injection = '"; echo HACKED & | $(test)'; r = await ask(injection); assert.equal(r.body.text, injection); assert.equal(spawns, before + 1);
  console.log(`PASS bad-input: bad-member=400 bad-instruction=400 injection=${JSON.stringify(r.body.text)} spawnDelta=1`);
  before = spawns;
  connection = { requestRejection: () => 403 }; r = await call({}, '', { noRead: true }); assert.equal(r.code, 401);
  connection = undefined; r = await call({}, '', { noRead: true }); assert.equal(r.code, 503);
  assert.equal(spawns, before); console.log('PASS auth: rejected=401 missing-service=503 bodyReads=0 spawnDelta=0');
  connection = { requestRejection: () => undefined };
  r = await ask('x', { member: 'dafish' }); assert.equal(r.body.status, 'unavailable'); assert.equal(spawns, before);
  r = await ask('fail'); assert.equal(r.body.status, 'failed'); assert.equal(r.body.exitCode, 7);
  r = await ask('empty'); assert.equal(r.body.status, 'empty'); assert.equal(r.body.usage, null);
  r = await ask('cat', { member: 'cat' }); assert.equal(r.body.text, 'Antigravity假程序回答'); assert.equal(r.body.source, 'agy-cli');
  r = await ask('flood'); assert.equal(r.body.status, 'empty'); assert.equal(handles.at(-1).size(), MAX_BYTES);
  for (const timeoutMs of [0, -1, 600001, '1000']) assert.equal((await ask('x', { timeoutMs })).code, 400);
  assert.equal((await call({}, '', { raw: '{' })).code, 400);
  assert.equal((await call({}, '', { method: 'GET' })).code, 405);
  assert.deepEqual((await call({ requestId: 'missing' }, '?action=cancel')).body, { cancelled: false });
  const duplicate = ask('sleep', { requestId: 'duplicate' }); await delay(200);
  assert.equal((await ask('x', { requestId: 'duplicate' })).code, 409);
  // 2026-10-12 补：同一位成员不许同时跑两轮（CLI 的续聊会话不能并发），错误原文里的登录网址要脱敏。
  // 这一段用**自己的一套端点**，跟上面那轮 long-running 的 duplicate 无关，也不会互相占用同一格。
  const busyApi = createHandler(ctx, config);
  const busyCall = body => {
    const req = Readable.from([JSON.stringify(body)]); req.method = 'POST'; req.url = '/api/three-agent-chat/ask';
    const res = new EventEmitter(); res.writeHead = code => { res.code = code; }; res.end = text => { res.body = JSON.parse(text); res.writableEnded = true; };
    return busyApi.handler(req, res).then(() => res);
  };
  const busyRun = busyCall({ member: 'longmei', instruction: 'sleep', timeoutMs: 1200 }); await delay(200);
  before = spawns;
  const busy = await busyCall({ member: 'longmei', instruction: '正常的一句话' });
  assert.equal(busy.body.status, 'unavailable'); assert.match(busy.body.error, /还在回答上一句/);
  assert.equal(spawns, before, '被挡的那一次不许起进程');
  const busyOut = await busyRun;
  assert.equal(busyOut.body.status, 'timeout');
  assert.equal((await busyCall({ member: 'longmei', instruction: '假程序原话' })).body.status, 'ok');
  await busyApi.dispose();
  assert.equal((await busyCall({ member: 'longmei', instruction: 'x' })).code, 503, '停用的那套端点必须 503');
  // 端点的成员白名单取自插件自己的 Config（HTTP 永远不能加成员），所以这一格只能直接挂到 Config 的 members 上。
  const urlMember = { exe: null, argsTemplate: [], requiresSession: true, sessionId: '', error: '登录 https://accounts.google.com/o/oauth2/auth?code_challenge=SECRET 之后再来' };
  Object.defineProperty(Config.members, 'probe', { value: urlMember, configurable: true, enumerable: true });
  const urlApi = createHandler(ctx, {});
  const urlReq = Readable.from([JSON.stringify({ member: 'probe', instruction: 'x' })]); urlReq.method = 'POST'; urlReq.url = '/api/three-agent-chat/ask';
  const urlRes = new EventEmitter(); urlRes.writeHead = code => { urlRes.code = code; }; urlRes.end = text => { urlRes.body = JSON.parse(text); urlRes.writableEnded = true; };
  await urlApi.handler(urlReq, urlRes);
  assert.equal(urlRes.body.status, 'unavailable');
  assert.equal(urlRes.body.error.includes('SECRET'), false, '登录网址必须被脱敏');
  assert.equal(urlRes.body.error.includes('<网址已省略>'), true);
  console.log('PASS busy+redact: 同成员第二轮被挡; 错误原文里的 OAuth 网址已省略');
  let cleanup, registered, removed = false;
  apply({ effect(fn) { cleanup = fn(); }, get(key) { return key === 'webServer' ? { register(spec) { registered = spec; return () => { removed = true; }; } } : ctx.get(key); } }, config);
  assert.equal(registered.kind, 'exact'); assert.equal(registered.path, '/api/three-agent-chat/ask'); await cleanup(); assert(removed);
  console.log('PASS extra: dafish/no-spawn failed empty cat flood<=262144 invalid-timeout malformed-json method duplicate registration');
  await api.dispose(); assert.equal((await duplicate).body.status, 'cancelled'); await treeStopped('dispose');
  assert.equal((await ask('x')).code, 503);
  console.log('ALL PASS; real CLI runs=0; host starts=0');
} finally {
  for (const h of handles) { h.terminate(); await h.waitForExit(); }
}
