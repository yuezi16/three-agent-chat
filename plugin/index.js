// Commands are trusted host configuration, never HTTP input.
// 2026-10-12 DeepSeek Harness实跑修过两处：① `-C` 是 exec 的选项，必须写在 resume **前面**（写后面报
// `error: unexpected argument '-C' found`，退出码 2、0.1 秒就死）；② 这台机器直连 codex 后端会
// `workspace routing discovery timed out`，子进程要显式带上代理（走 127.0.0.1:10808）。
// 2026-10-12 17:5x 补：必须声明依赖，否则 apply 会抢在 webserver 起来之前跑，
// `ctx.get('webServer')` 拿到 undefined，register 抛错被吞掉 —— 面板一路 404。
// cordis 的规矩：inject 里点名的服务没就位，插件就停在「等待」状态，就位后才 apply。
// 2026-10-12 18:5x 抓到真凶：`export const Config` 必须是**带 `~standard` 的校验器**（Standard Schema）。
// 原来写成一个普通对象，而 cordis 的 resolveConfig 只要看到 Config 就直接读 `Config['~standard'].validate(...)`
// → `TypeError: Cannot read properties of undefined (reading 'validate')`，插件每次加载都在这一步炸掉、
// `apply` 一次都没跑过（症状：面板点谁都 404）。最小复现见 host-endpoint/probe/02-real-plugin.mjs。
export const inject = ['webServer', 'subprocess'];
// 这份默认值只是「开箱即用的一套示例」：路径、代理、会话 ID 都请按自己的机器改。
// 环境变量优先，方便不改代码就换机器。
const PROXY = process.env.THREE_AGENT_PROXY || 'http://127.0.0.1:10808';
// 每台机器的路径与会话 ID 都不一样，所以真正的值放在 plugin/local-config.mjs 里（那个文件不进版本库）。
// 没有它就退回下面这套示例默认值（路径里带 <you> 的那种）。
let local = {};
try { local = (await import('./local-config.mjs')).default ?? {}; } catch { local = {}; }
const pick = key => process.env[key] ?? local[key];
const defaults = {
  cwd: pick('THREE_AGENT_CWD') || process.cwd(), graceMs: 500,
  // 外部 CLI 要连自己的后端；直连不通时把代理填在这里（也可以设 THREE_AGENT_PROXY 覆盖）。
  // NO_PROXY 必须含本机回环，否则面板自己打宿主端点也会被塞进代理。
  env: {
    HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
  },
  members: {
    dafish: { displayName: 'DeepSeek Harness', exe: null, argsTemplate: [], source: 'dsh-native' },
    longmei: {
      displayName: 'Codex CLI', source: 'codex-cli',
      // 实测（2026-10-12 17:2x）：一句话的一轮 ≈ input 15525 / cached 12544 / output 5 token，9.4 秒。
      // 续聊靠这个会话 ID：先手动跑一次 `codex exec --json --skip-git-repo-check -- "hello"`，
      // 从输出的 thread.started 事件里抄下来填进 local-config.mjs。
      sessionId: pick('THREE_AGENT_CODEX_SESSION') || '<your-codex-session-id>', requiresSession: true,
      // Windows 上 npm 全局装 codex 时，真正的可执行文件在包内的 vendor 目录里（下面是示例路径）。
      exe: pick('CODEX_EXE') || 'C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
      argsTemplate: ['exec', '-C', '{cwd}', 'resume', '{sessionId}', '--json', '--skip-git-repo-check', '--', '{instruction}'],
    },
    cat: {
      // 实测（2026-10-12 17:3x）：agy 的 -p 会把紧跟其后的词当成提示词，所以必须用 `-p=<提示词>` 的
      // 等号写法（写成 `-p --output-format json` 会报「-p took "--output-format" as its prompt」直接退出 2）。
      // 另外 agy 必须先在终端里登录一次（Google OAuth 直连常拿不到令牌，登录时先设好代理）；
      // 登录后跑一轮真任务，从回包里抄 conversation_id 填进 local-config.mjs。
      displayName: 'Antigravity', source: 'agy-cli',
      sessionId: pick('THREE_AGENT_AGY_CONVERSATION') || '<your-agy-conversation-id>', requiresSession: true,
      exe: pick('AGY_EXE') || 'C:\\Users\\<you>\\AppData\\Local\\agy\\bin\\agy.exe',
      argsTemplate: ['-p={instruction}', '--output-format', 'json', '--conversation', '{sessionId}', '--print-timeout', '300s'],
    },
  },
};
export const Config = {
  ...defaults,
  '~standard': {
    version: 1,
    vendor: 'three-agent-chat',
    validate(value) {
      if (value === undefined || value === null) return { value: defaults };
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: '插件配置必须是一个对象。', path: [] }] };
      }
      return {
        value: {
          ...defaults, ...value,
          env: value.env === undefined ? defaults.env : value.env,
          members: value.members === undefined ? defaults.members : value.members,
        },
      };
    },
  },
};
export const MAX_BYTES = 256 * 1024;
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function send(res, code, value) {
  if (!res.destroyed && !res.writableEnded) { res.writeHead(code, headers); res.end(JSON.stringify(value)); }
}
function bad(res, status, code, error) { send(res, status, { error, code }); }
async function bodyOf(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 64 * 1024) throw new Error('请求体超过 64 KB。');
    chunks.push(bytes);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象。');
  return body;
}
// Only answer events count; tool output never impersonates a member answer.
export function parseOutput(raw, source) {
  // 探针用：没有 JSON 协议的子进程，stdout 原文就是回答（不能等 JSON 解析出事件，纯文本永远解析不出来）。
  if (source === 'raw') return { text: raw.trim(), usage: null, failure: null };
  let events;
  try { events = [JSON.parse(raw)]; }
  catch { events = raw.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  const texts = []; let usage = null; let failure = null;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (source === 'codex-cli') {
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') texts.push(event.item.text);
      if (event.type === 'turn.failed' || event.type === 'error') failure = event.error?.message || event.message || 'CLI 报告执行失败。';
    } else if (source === 'agy-cli') {
      if (typeof event.response === 'string') texts.push(event.response);
      if (event.status && event.status !== 'SUCCESS') failure = typeof event.error === 'string' ? event.error : 'CLI 报告执行失败。';
    }
    const u = event.usage;
    if (u) {
      // 两家的字段名不一样，而且**缺项要当 0**（实测 agy 首跑没有 cache_read_tokens，
      // 旧写法只要有一项不是数字就整条丢弃，结果用量永远解析不出来）。
      const values = [u.input_tokens ?? u.inputTokens ?? 0, u.cached_input_tokens ?? u.cachedTokens ?? 0, u.output_tokens ?? u.outputTokens ?? 0];
      if (values.every(n => Number.isFinite(n) && n >= 0)) usage = { inputTokens: values[0], cachedTokens: values[1], outputTokens: values[2] };
    }
  }
  return { text: texts.join('\n'), usage, failure };
}
// 给主人看、我要记账的错误原文里可能夹着一次性登录网址（实测 agy 未登录时会把一条带 code_challenge 的
// Google OAuth 地址吐出来）——只脱敏 URL，别的一字不改，这样报错仍然可核对。
export function sanitize(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/https?:\/\/\S+/g, '<网址已省略>').slice(0, 300);
}
export function createHandler(ctx, config = {}) {
  const cfg = { ...Config, ...config, members: { ...Config.members, ...config.members } };
  const active = new Map(); const memberBusy = new Map(); let disposed = false;
  async function handler(req, res) {
    // Authentication before method, URL or body access; missing service fails closed.
    try {
      const connection = ctx.get('connection');
      if (typeof connection?.requestRejection !== 'function') return bad(res, 503, 'unavailable', '宿主认证服务暂不可用。');
      if (connection.requestRejection(req) !== undefined) return bad(res, 401, 'unauthorized', '请先登录；已拒绝不可信或跨站请求。');
    } catch { return bad(res, 503, 'unavailable', '宿主认证服务暂不可用。'); }
    if (disposed) return bad(res, 503, 'unavailable', '端点已停止。');
    if (req.method !== 'POST') return bad(res, 405, 'bad-instruction', '只接受 POST。');
    let body, action;
    try { action = new URL(req.url, 'http://localhost').searchParams.get('action'); body = await bodyOf(req); }
    catch { return bad(res, 400, 'bad-instruction', '请求体必须是有效 JSON，且不超过 64 KB。'); }
    if (disposed) return bad(res, 503, 'unavailable', '端点已停止。');
    if (body.requestId !== undefined && typeof body.requestId !== 'string') return bad(res, 400, 'bad-instruction', 'requestId 必须是字符串。');
    if (action === 'cancel') {
      const run = active.get(body.requestId);
      const cancelled = !!run && run.stop('cancelled');
      if (cancelled && await run.finished === false) return bad(res, 503, 'unavailable', '进程树清理未确认，请由宿主检查。');
      return send(res, 200, { cancelled });
    }
    if (action !== null) return bad(res, 400, 'bad-instruction', '未知 action。');
    if (typeof body.member !== 'string' || !Object.hasOwn(Config.members, body.member)) return bad(res, 400, 'bad-member', '成员不在白名单中。');
    if (typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > 8000) return bad(res, 400, 'bad-instruction', '指令必须是 1–8000 字符的非空字符串。');
    const timeout = body.timeoutMs ?? 120000;
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 600000) return bad(res, 400, 'bad-instruction', 'timeoutMs 必须是 1–600000 的整数。');
    const key = body.requestId ?? Symbol();
    if (active.has(key)) return bad(res, 409, 'bad-instruction', 'requestId 正在执行，不能重复。');
    const member = cfg.members[body.member], identity = Config.members[body.member];
    const startedAt = Date.now();
    const result = { requestId: body.requestId ?? null, member: body.member, displayName: identity.displayName,
      status: 'unavailable', text: '', startedAt, endedAt: startedAt, durationMs: 0,
      usage: null, exitCode: null, source: identity.source, error: null };
    const reply = () => { result.endedAt = Date.now(); result.durationMs = result.endedAt - startedAt; send(res, 200, result); };
    if (body.member === 'dafish') { result.error = '主理人这一格由 DSH 本体直接对话，不走面板调用。'; return reply(); }
    let subprocess;
    try { subprocess = ctx.get('subprocess'); } catch { /* unavailable below */ }
    if (!subprocess?.spawn || !member?.exe || (member.requiresSession && !member.sessionId)) {
      // 成员自己带的话（比如「先登录」）要原样转达给主人，但网址必须脱敏——实测 agy 未登录时会吐一条 OAuth 地址。
      const why = member?.error ? `：${sanitize(member.error)}` : '。';
      result.error = `子进程服务、可执行文件或显式会话 ID 未配置${why}`; return reply();
    }
    // 同一个成员同时只跑一轮：CLI 的续聊会话不能并发，两轮挤在一起会把会话里的上下文搅乱。
    if (memberBusy.has(body.member)) { result.error = '这位成员还在回答上一句，等它答完再点名。'; return reply(); }
    const controller = new AbortController(); let handle, timer, reason, settled = false, cleanupConfirmed = true;
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const run = { finished, stop(value) {
      if (settled || reason) return false;
      reason = value; controller.abort(); handle?.terminate(); return true;
    } };
    const disconnect = () => { if (!res.writableEnded) run.stop('cancelled'); };
    active.set(key, run); memberBusy.set(body.member, key);
    req.on('aborted', disconnect); res.on('close', disconnect);
    try {
      const replacements = { '{instruction}': body.instruction, '{sessionId}': member.sessionId, '{cwd}': cfg.cwd };
      // 占位符既可能独占一个元素（codex 的 `{instruction}`），也可能嵌在元素里（agy 的 `-p={instruction}`），
      // 所以对每个元素做子串替换；不是整串匹配才算命中（2026-10-12 Antigravity首跑就是被这个坑住：指令没送进去，
      // 她收到的是字面量 `{instruction}`）。
      const argv = [member.exe, ...member.argsTemplate.map(arg => {
        let value = arg;
        for (const [token, replacement] of Object.entries(replacements)) value = value.replaceAll(token, replacement);
        return value;
      })];
      handle = subprocess.spawn({ argv, cwd: cfg.cwd, graceMs: cfg.graceMs, signal: controller.signal, env: cfg.env,
        stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_BYTES }, stderr: { maxBytes: MAX_BYTES } } });
      timer = setTimeout(() => run.stop('timeout'), timeout);
      const outcome = await handle.done;
      // Provider owns the Windows process scope; main-process exit is insufficient.
      if (await handle.waitForExit() !== true) throw new Error('托管进程范围未确认清空。');
      settled = true;
      result.exitCode = outcome.exitCode;
      const output = handle.collected.stdout?.readFrom(0);
      const parsed = parseOutput(output?.text ?? '', identity.source);
      result.text = parsed.text; result.usage = parsed.usage;
      result.status = reason ?? (outcome.exitCode !== 0 || parsed.failure ? 'failed' : parsed.text ? 'ok' : 'empty');
      result.error = reason === 'timeout' ? '执行超时，进程树已停止。' : reason === 'cancelled' ? '执行已取消，进程树已停止。'
        : sanitize(parsed.failure) || (outcome.exitCode !== 0 ? `CLI exited with code ${outcome.exitCode}` : parsed.text ? null : '未解析到成员回答。');
      if (output?.lossy && result.status === 'ok') { result.status = 'failed'; result.error = '输出超过收集上限，回答不完整。'; }
    } catch (error) {
      if (handle) {
        controller.abort(); handle.terminate();
        try { if (await handle.waitForExit() !== true) throw new Error('托管进程范围未确认清空。'); }
        catch { cleanupConfirmed = false; settled = true; return bad(res, 503, 'unavailable', '进程树清理未确认，请由宿主检查。'); }
      }
      result.status = reason ?? (error.code === 'ENOENT' ? 'unavailable' : 'failed');
      result.error = sanitize(error.message) || 'CLI 执行失败。';
    } finally {
      settled = true; clearTimeout(timer); active.delete(key);
      if (memberBusy.get(body.member) === key) memberBusy.delete(body.member);
      req.off('aborted', disconnect); res.off('close', disconnect); finish(cleanupConfirmed);
    }
    reply();
  }
  async function dispose() {
    disposed = true;
    const runs = [...active.values()]; runs.forEach(run => run.stop('cancelled'));
    if ((await Promise.all(runs.map(run => run.finished))).includes(false)) throw new Error('进程树清理未确认。');
  }
  return { handler, dispose };
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const api = createHandler(ctx, config);
    const unregister = ctx.get('webServer').register({ kind: 'exact', path: '/api/three-agent-chat/ask', handler: api.handler });
    return async () => { unregister(); await api.dispose(); };
  });
}
