import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHandler, apply, MAX_BYTES, Config } from '../plugin/index.js';
// Pure control-flow tests: no child_process import; no executable is launched.
let count = 0, spec, terminated = 0, waited = 0, scopeEmpty = false;
let connection = { requestRejection: () => undefined };
let mode = 'ok';
const provider = { spawn(value) {
  count++; spec = value; scopeEmpty = false;
  if (mode === 'missing') throw Object.assign(new Error('fixture ENOENT'), { code: 'ENOENT' });
  let resolve;
  const done = new Promise(r => { resolve = r; });
  const handle = {
    done, terminate() { terminated++; resolve({ exitCode: null, signal: 'SIGTERM' }); },
    async waitForExit() { waited++; await delay(20); scopeEmpty = true; return true; },
    collected: { stdout: { readFrom() { return { text: mode === 'empty' ? '{}' : mode === 'cat' ? '{"status":"SUCCESS","response":"cat fixture"}' : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: spec.argv.at(-1) } }), lossy: mode === 'lossy' }; } } },
  };
  if (mode !== 'wait') resolve({ exitCode: mode === 'fail' ? 7 : 0, signal: null });
  return handle;
} };
const cfg = { members: { longmei: { exe: 'never-executed', argsTemplate: ['{instruction}'] }, cat: { exe: 'never-executed', argsTemplate: ['{instruction}'] } } };
const ctx = { get: key => key === 'connection' ? connection : provider };
const api = createHandler(ctx, cfg);
function call(body, suffix = '', opts = {}) {
  const req = Readable.from([opts.raw ?? JSON.stringify(body)]);
  req.method = opts.method ?? 'POST'; req.url = `/api/three-agent-chat/ask${suffix}`;
  if (opts.noRead) req[Symbol.asyncIterator] = () => { throw new Error('body read before auth'); };
  const res = new EventEmitter(); res.writeHead = code => { res.code = code; };
  res.end = text => { res.body = JSON.parse(text); res.writableEnded = true; };
  return api.handler(req, res).then(() => res);
}
const ask = (instruction, extra = {}) => call({ member: 'longmei', instruction, ...extra });
let r = await ask('literal ; & | $(echo HACKED)', { requestId: 'id' });
assert.equal(r.body.status, 'ok'); assert.equal(r.body.text, spec.argv.at(-1)); assert(r.body.durationMs > 0);
assert.equal(r.body.usage, null); assert(scopeEmpty); assert.equal(spec.stdio.stdout.maxBytes, MAX_BYTES);
assert.deepEqual(Object.keys(r.body).sort(), ['requestId','member','displayName','status','text','startedAt','endedAt','durationMs','usage','exitCode','source','error'].sort());
console.log('PASS unit normal: fixed JSON shape; literal argv; bounded collectors; usage=null');
mode = 'wait'; r = await ask('sleep', { timeoutMs: 10 });
assert.equal(r.body.status, 'timeout'); assert(spec.signal.aborted); assert(terminated > 0); assert(scopeEmpty);
console.log('PASS unit timeout: AbortSignal + terminate + awaited scope confirmation (mock only)');
const pending = ask('sleep', { requestId: 'cancel' }); await delay(5);
r = await call({ requestId: 'cancel' }, '?action=cancel'); assert.deepEqual(r.body, { cancelled: true }); assert(scopeEmpty);
assert.equal((await pending).body.status, 'cancelled');
assert.deepEqual((await call({ requestId: 'cancel' }, '?action=cancel')).body, { cancelled: false });
console.log('PASS unit cancel: cancelled=true; original=cancelled; absent=false (mock only)');
let before = count;
for (const member of ['bad', '__proto__', 'constructor']) { r = await ask('x', { member }); assert.equal(r.code, 400); assert.equal(r.body.code, 'bad-member'); }
r = await ask('x'.repeat(15000)); assert.equal(r.body.code, 'bad-instruction');
for (const timeoutMs of [0, -1, 600001, '1']) assert.equal((await ask('x', { timeoutMs })).code, 400);
assert.equal((await call({}, '', { raw: '{' })).code, 400); assert.equal(count, before);
connection = { requestRejection: () => 403 }; r = await call({}, '', { noRead: true }); assert.equal(r.code, 401);
connection = undefined; r = await call({}, '', { noRead: true }); assert.equal(r.code, 503);
connection = { requestRejection() { throw new Error('auth unavailable'); } }; assert.equal((await call({}, '', { noRead: true })).code, 503);
assert.equal(count, before); connection = { requestRejection: () => undefined };
console.log('PASS unit validation/auth: 400 bad-member/bad-instruction; 401 rejection; 503 missing/throw; no spawn');
r = await ask('x', { member: 'dafish' }); assert.equal(r.body.status, 'unavailable'); assert.equal(count, before);
for (const [value, expected] of [['missing', 'unavailable'], ['fail', 'failed'], ['empty', 'empty'], ['lossy', 'failed']]) {
  mode = value; assert.equal((await ask('x')).body.status, expected);
}
mode = 'cat'; assert.equal((await ask('x', { member: 'cat' })).body.text, 'cat fixture');
mode = 'wait'; const pendingDispose = ask('x', { requestId: 'dup' }); await delay(5);
assert.equal((await ask('x', { requestId: 'dup' })).code, 409);
await api.dispose(); assert.equal((await pendingDispose).body.status, 'cancelled'); assert(scopeEmpty);
assert.equal((await ask('x')).code, 503);
let cleanup, registration, unregistered = false;
apply({ effect(fn) { cleanup = fn(); }, get(key) { return key === 'webServer' ? { register(value) { registration = value; return () => { unregistered = true; }; } } : ctx.get(key); } }, cfg);
assert.equal(registration.path, '/api/three-agent-chat/ask'); assert.equal(registration.kind, 'exact'); await cleanup(); assert(unregistered);
assert(Config.members.longmei.exe.endsWith('codex.exe')); assert(Config.members.cat.exe.endsWith('agy.exe'));
console.log('PASS unit statuses/dispose: dafish unavailable failed empty lossy cat duplicate unregister');
console.log(`UNIT ALL PASS; provider calls=${count}; waitForExit calls=${waited}; actual process launches=0`);
