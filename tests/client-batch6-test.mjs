// Offline only: execute the real client with a tiny hooks renderer and fake fetch.
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
const SESSION_ID = 'sess-fixture-1'
const results = []
const progressPath = new URL('client-batch6-progress.log', import.meta.url)
const step = message => appendFileSync(progressPath, '   .. ' + message + '\n')
writeFileSync(progressPath, '')
function harness(options = {}) {
  const hooks = []
  const initialized = new Set()
  const requests = []
  let cursor = 0
  let component
  /* useEffect 的假实现：依赖变了才重跑，重跑前先清掉上一次的收尾函数。
     只服务面板里那个「每秒刷新等待读数」的计时器，不追求真 React 的全部语义。 */
  const effects = []
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const timers = []
  const controllers = []
  const clearTimer = id => { const index = timers.indexOf(id); if (index >= 0) timers.splice(index, 1) }
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = cursor++
      // 首渲染时才置初值，之后每次渲染都交回上一次的值（不然面板一重渲染就把状态丢了）。
      if (!initialized.has(index)) { hooks[index] = initial; initialized.add(index) }
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }]
    },
    useRef(initial) {
      const index = cursor++
      if (!initialized.has(index)) { hooks[index] = { current: initial }; initialized.add(index) }
      return hooks[index]
    },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = effects[index]
      effects[index] = { deps }
      if (previous && depsEqual(previous.deps, deps)) return
      if (typeof previous?.cleanup === 'function') previous.cleanup()
      effects[index].cleanup = effect()
    },
    useMemo(factory) { return factory() },
    useCallback(fn) { return fn },
    /* 真 React 里 class 组件的最小形状：面板的兜底（PanelBoundary）要 extends 它。
       没有这个，插件一加载就会在 `class ... extends React.Component` 那行当场炸掉。 */
    Component: class Component {
      constructor(props) { this.props = props }
    },
  }
  /* 假的会话把手：只实现客户端代码真正用到的那几样。
     windows/notify 一对是给面板读会话事件流用的（等回答＝订阅 eventSource + 自己扫 entries）。 */
  const windows = []
  if (options.priorAssistantText) {
    windows.push({ type: 'event', event: { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: options.priorAssistantText }] } } } })
  }
  const notify = []
  const promptCalls = []
  let busy = false
  const binding = {
    sessionId: SESSION_ID,
    session: {
      prompt(content, mode, signal) {
        promptCalls.push({ content, mode, signal })
        /* 真行为：宿主一收下这句话，prompt() 立刻回 {ok:true}（回包只代表"已入队"），
           回答是之后从会话事件流里冒出来的。所以这里也必须先兑现，否则面板根本走不到
           「订阅事件流等回答」那一步。signal 一断就当作报废。 */
        if (signal?.aborted) return Promise.reject(new Error('aborted'))
        const accepted = Promise.resolve({ ok: true, value: { accepted: true } })
        return signal?.addEventListener
          ? Promise.race([accepted, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))])
          : accepted
      },
    },
    eventSource: {
      getSnapshot: () => ({ entries: [...windows] }),
      subscribe(listener) { notify.push(listener); return () => { const index = notify.indexOf(listener); if (index >= 0) notify.splice(index, 1) } },
    },
    ctx: {},
  }
  const sessions = {
    binding(id) { assert.equal(id, SESSION_ID); return binding },
    /* 现成的把手借不到时才会走这条路。测试里故意让它报错：真行为下一旦走到这里，
       说明「这个会话没被 retain」，面板该把话说清楚而不是装作没事。 */
    using(id) { assert.equal(id, SESSION_ID); throw new Error('fake: 这个会话没有现成的把手') },
  }
  const pushEvent = event => { windows.push({ type: 'event', event }); notify.slice().forEach(listener => listener()) }
  vm.runInNewContext(source, {
    // 面板里只用到这两个计时器（每秒刷新等待读数），用假计时器就没有「测试跑完进程不退出」的麻烦。
    setInterval(fn) { const id = { fn }; timers.push(id); return id },
    clearInterval(id) { clearTimer(id) },
    // 「等回答超时」用的真计时器：测试里不会真等到 600 秒。
    setTimeout, clearTimeout,
    // 会话的提交口是客户端自己的 AbortController（Node 里本来就有，但 vm 的新上下文里要显式给）。
    // 包一层只为记账：收手之后每个控制器都该真的处于 aborted，不然就是「点了收手还在等」。
    AbortController: class extends AbortController { constructor() { super(); controllers.push(this) } },
    window: { __ModuleLoader__: { load({ id, factory }) {
      assert.equal(id, 'three-agent-chat')
      const plugin = factory(name => { assert.equal(name, 'react'); return React })
      assert.deepEqual(Array.from(plugin.inject), ['slots', 'sessions'])
      plugin.apply({ slots: {
        inject(slot, callback) { assert.equal(slot, 'conversation.session.header.utilities'); callback() },
        register(options, panel) { assert.equal(options.id, 'three-agent-chat:panel'); component = panel },
      }, sessions })
    } } },
    fetch(url, options) {
      assert.equal(options.method, 'POST')
      assert.equal(options.headers['content-type'], 'application/json')
      assert.equal(options.credentials, 'same-origin')
      return new Promise((resolve, reject) => requests.push({
        url, body: JSON.parse(options.body), reject,
        // 2026-10-12 18:3x：客户端改成先 response.text() 再自己 JSON.parse（防兜底 404 的非 JSON），
        // 所以这个假应答也要有 text()。
        reply(data, status = 200) { resolve({ status, json: async () => data, text: async () => JSON.stringify(data) }) },
        // 专门用来喂「宿主回非 JSON」那一条：原文是什么就回什么。
        replyRaw(text, status = 200) { resolve({ status, json: async () => JSON.parse(text), text: async () => text }) },
      }))
    },
  })
  const render = () => { cursor = 0; return component({ sessionId: options.noSessionId ? undefined : SESSION_ID, useSession: () => ({ running: busy }) }) }
  /* 把元素树摊平：函数组件调一次、class 组件建实例后调 render()；
     class 组件抛错时按 React 的兜底语义处理（getDerivedStateFromError 换 state、componentDidCatch 上报后重渲染）。
     面板现在挂着 PanelBoundary 这层 class 兜底，所以必须认 class 组件，否则测试根本走不到 textarea。 */
  const instances = new Map()
  const walk = (node, depth = 0) => {
    if (node == null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.flat(Infinity).map(child => walk(child, depth + 1))
    const { type } = node
    if (type === 'fragment') return { type, props: node.props || {}, children: walk(node.children, depth + 1) }
    if (typeof type === 'function' && type.prototype && typeof type.prototype.render === 'function') {
      /* 假 createElement 把子元素放在 element.children，真 React 放在 props.children。
         class 组件（面板的兜底 PanelBoundary）读的是 this.props.children，两边都要给到。 */
      const kids = node.props?.children !== undefined ? node.props.children : node.children
      const props = { ...(node.props || {}), children: kids }
      let instance = instances.get(node)
      if (!instance) { instance = new type(props); instances.set(node, instance) }
      try {
        return { type, props, children: walk(instance.render(), depth + 1) }
      } catch (error) {
        const derived = typeof type.getDerivedStateFromError === 'function' ? type.getDerivedStateFromError(error) : null
        if (!derived) throw error
        instance.state = { ...instance.state, ...derived }
        if (typeof instance.componentDidCatch === 'function') instance.componentDidCatch(error)
        return { type, props, children: walk(instance.render(), depth + 1) }
      }
    }
    if (typeof type === 'function') return walk(type(node.props), depth + 1)
    return { ...node, children: walk(node.children, depth + 1) }
  }
  const find = (node, predicate) => {
    if (node == null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) { for (const child of node) { const match = find(child, predicate); if (match) return match } return undefined }
    if (predicate(node)) return node
    for (const child of node.children || []) { const match = find(child, predicate); if (match) return match }
  }
  /* 注意：早期这行把 className==='tac-error' 的节点整段丢掉，于是「请求错误提示 /
     状态说明 / 收手说明」这几行在断言里根本看不见——曾经因此把一个真 bug 和一堆
     假失败搅在一起。错误行必须算进文本里。 */
  const text = node => node == null ? '' : (typeof node === 'object'
    ? (Array.isArray(node) ? node.map(text).join('') : (node.children || []).map(text).join(''))
    : String(node))
  const tree = () => walk(render())
  const row = key => find(tree(), node => node.props?.className === 'tac-member' && node.props.key === key)
  const button = (key, label) => find(row(key), node => node.type === 'button' && text(node) === label)
  find(tree(), node => node.type === 'button' && text(node) === '协作 ▾').props.onClick()
  return {
    requests, row, text, button, render, find, sessions, promptCalls, pushEvent, tree,
    setBusy(value) { busy = value },
    subscribers() { return notify.length },
    controllers() { return controllers },
    input(value) {
      const flat = tree()
      if (process.env.TAC_DEBUG === 'probe') {
        const box = []
        const collect = node => { if (!node || typeof node !== 'object') { box.push('leaf'); return }; if (Array.isArray(node)) { node.forEach(collect); return }; box.push(typeof node.type === 'string' ? node.type : (node.type?.name || 'fn')); (node.children || []).forEach(collect) }
        collect(flat)
        console.log('DEBUG input 时的树：', JSON.stringify(box))
      }
      find(flat, node => node.type === 'textarea').props.onChange({ target: { value } })
    },
    pick(key) { return button(key, '点名').props.onClick() },
    // DeepSeek Harness那格的停止按钮叫「收手」（它只收手、不去停会话），Codex CLI/Antigravity才叫「停止」。
    stop(key) { return (button(key, '停止') || button(key, '收手')).props.onClick() },
    reply(index, overrides = {}, status = 200) {
      const req = requests[index]
      req.reply({ ...req.body, displayName: 'fixture', status: 'ok', text: '原话\n第二行 <script>不执行</script>',
        source: req.body.member === 'cat' ? 'agy-cli' : 'codex-cli', durationMs: 12300,
        usage: { inputTokens: 32500, cachedTokens: 28000, outputTokens: 900 }, error: null, ...overrides }, status)
    },
  }
}
async function test(name, action) {
  // 边跑边把进度写到日志文件里：这套回归里有「等回答」的异步等待，
  // 万一哪条挂住，进程不会自己退出，此时只能靠这份文件定位到卡在哪一条。
  appendFileSync(progressPath, 'START ' + name + '\n')
  await action()
  appendFileSync(progressPath, 'DONE  ' + name + '\n')
  results.push({ test: name, pass: true })
}
/* 等异步链路走完：面板「先提交进会话、再订阅事件流等回答」是异步两步，
   断言订阅者/收手结果之前先让微任务跑干净。 */
const settle = async (ticks = 12) => { for (let i = 0; i < ticks; i++) await Promise.resolve() }
const RUNNING = /状态：(?:跑着…|等着回答 · 已等 \d+ 秒)/

if (process.env.TAC_DEBUG === 'probe') {
  console.log('DEBUG 开关进来了')
  const app = harness()
  const flat = app.tree()
  const types = []
  const collect = node => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { node.forEach(collect); return }; types.push(typeof node.type === 'string' ? node.type : (node.type?.name || 'fn') + ':' + JSON.stringify(node.props?.className)); (node.children || []).forEach(collect) }
  collect(flat)
  console.log('DEBUG 摊平后的节点：', JSON.stringify([...new Set(types)]))
  console.log('DEBUG 有 textarea 吗：', !!app.find(flat, node => node.type === 'textarea'))
  console.log('DEBUG 直接读面板元素：', JSON.stringify(flat.children.map(child => typeof child === 'string' ? child : (child.type?.name || child.type))))
  const boundary = app.find(flat, node => node.type?.name === 'PanelBoundary')
  console.log('DEBUG 兜底拿到的 children：', JSON.stringify((boundary?.children || []).map(child => typeof child === 'string' ? child : (child?.type?.name || child?.type || String(child)))))
  const raw = app.render()
  const rawBoundary = raw.children.find(child => child && typeof child === 'object' && child.type?.name === 'PanelBoundary')
  console.log('DEBUG 原始元素里的 children：', JSON.stringify((rawBoundary?.children || []).map(child => typeof child === 'string' ? child : (child?.type?.name || child?.type || String(child)))))
  console.log('DEBUG 原始 fragment 的元素个数：', raw.children.length, '｜ 类型：', JSON.stringify(raw.children.map(child => child == null ? String(child) : (child.type?.name || child.type))))
  app.input('帮我看看现在几点')
  const returned = app.pick('dafish')
  console.log('DEBUG 点名返回值是个 Promise 吗：', returned && typeof returned.then === 'function')
  console.log('DEBUG prompt 被调次数：', app.promptCalls.length)
  console.log('DEBUG 订阅者个数：', app.subscribers())
  console.log('DEBUG 行文本：', JSON.stringify(app.text(app.row('dafish')).slice(0, 80)))
  app.pushEvent({ type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: '现在是下午三点。' }] } } })
  console.log('DEBUG 推完事件后订阅者个数：', app.subscribers())
  const settled = await Promise.race([Promise.resolve(returned).then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('timeout'), 500))])
  console.log('DEBUG 等待结果：', settled)
  console.log('DEBUG 行文本：', JSON.stringify(app.text(app.row('dafish')).slice(0, 120)))
  process.exit(0)
}

await test('dafish_sends_into_this_session_not_http', async () => {
  const app = harness()
  app.input('帮我看看现在几点')
  const pending = app.pick('dafish')
  // 关键：DeepSeek Harness这一格不许走 HTTP 端点，也不许伪造 member/requestId 去冒充别人。
  assert.equal(app.requests.length, 0)
  assert.equal(app.promptCalls.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(app.promptCalls[0].content)), [{ type: 'text', text: '帮我看看现在几点' }])
  assert.equal(app.promptCalls[0].mode, 'queue')
  assert.match(app.text(app.row('dafish')), /状态：等着回答 · 已等 \d+ 秒/)
  app.pushEvent({ type: 'assistant/message', seq: 7, data: {
    message: { content: [{ type: 'text', text: '现在是下午三点。' }] },
    usage: { input_tokens: 1234, cache_read_input_tokens: 1000, output_tokens: 20 },
  } })
  await pending
  const shown = app.text(app.row('dafish'))
  assert.match(shown, /状态：正常/)
  assert.match(shown, /来源：DSH 主会话（本窗对话）/)
  assert.match(shown, /输入 \/ 缓存 \/ 输出 token：1234 \/ 1000 \/ 20/)
  assert.doesNotMatch(shown, /sess-fixture-1|会话 ID：/)
  assert.equal(app.text(app.find(app.row('dafish'), node => node.props.className === 'tac-text')), '现在是下午三点。')
})
await test('dafish_earlier_answer_is_never_taken_as_this_reply', async () => {
  const app = harness({ priorAssistantText: '上一轮的回答' })
  app.input('再说一句')
  const pending = app.pick('dafish')
  // 上一轮的回答（seq 1）在基线之前，不许被当成本次回答。
  assert.match(app.text(app.row('dafish')), /状态：等着回答 · 已等 \d+ 秒/)
  assert.doesNotMatch(app.text(app.row('dafish')), /上一轮的回答/)
  app.pushEvent({ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '这轮的新回答' }] } } })
  await pending
  assert.match(app.text(app.row('dafish')), /这轮的新回答/)
  assert.doesNotMatch(app.text(app.row('dafish')), /上一轮的回答/)
})
await test('dafish_stop_aborts_and_releases_the_subscriber_only', async () => {
  const app = harness()
  app.input('测试收手')
  const pending = app.pick('dafish')
  await settle()
  assert.equal(app.subscribers(), 1)
  app.stop('dafish')
  await pending
  const shown = app.text(app.row('dafish'))
  // 收手是主人自己的动作：状态写「已收手」+ 一句说明，不该残留「失败」，也不该有来源/耗时/token。
  assert.match(shown, /状态：已收手/)
  assert.doesNotMatch(shown, /请求错误提示|状态：失败|状态：正常|来源：/)
  assert.equal(app.subscribers(), 0)
  // 收手后每个控制器都该真的断了：断不掉就等于「点了收手还在等」。
  assert.equal(app.controllers().filter(item => !item.signal.aborted).length, 0)
})
await test('dafish_turn_end_error_is_reported_as_failure', async () => {
  const app = harness()
  app.input('测试失败')
  const pending = app.pick('dafish')
  app.pushEvent({ type: 'turn/end', seq: 9, data: { reason: { kind: 'error', error: { message: '模型调用被拒' } } } })
  await pending
  const shown = app.text(app.row('dafish'))
  assert.match(shown, /状态：失败/)
  assert.match(shown, /模型调用被拒/)
})
await test('dafish_status_unavailable_without_session_id', async () => {
  const app = harness({ noSessionId: true })
  app.input('测试')
  await app.pick('dafish')
  assert.match(app.text(app.row('dafish')), /没认出是哪个会话/)
  assert.equal(app.promptCalls.length, 0)
  assert.equal(app.requests.length, 0)
})
await test('empty_instruction_no_fetch', async () => {
  const app = harness()
  app.input('  \n ')
  await app.pick('longmei')
  assert.equal(app.requests.length, 0)
  assert.match(app.text(app.tree()), /请先写一句指令/)
})
await test('host_non_json_reply_is_reported_verbatim', async () => {
  const app = harness()
  app.input('你好')
  const pending = app.pick('longmei')
  app.requests[0].replyRaw('not found', 500)
  await pending
  const shown = app.text(app.row('longmei'))
  assert.match(shown, /宿主回了非 JSON（HTTP 500）/)
  assert.match(shown, /not found/)
  assert.doesNotMatch(shown, /Unexpected token/)
})
await test('ok_source_duration_usage_verbatim_and_contract', async () => {
  const app = harness()
  app.input('  主人的指令\n原样发送  ')
  const pending = app.pick('longmei')
  assert.equal(app.requests[0].url, '/api/three-agent-chat/ask')
  assert.equal(app.requests[0].body.instruction, '  主人的指令\n原样发送  ')
  assert.equal(app.requests[0].body.timeoutMs, 120000)
  assert.match(app.requests[0].body.requestId, /^tac-\d+-\d+$/)
  assert.match(app.text(app.row('longmei')), RUNNING)
  assert.equal(app.button('longmei', '点名').props.disabled, true)
  await app.pick('longmei') // rapid repeat cannot start duplicate paid calls
  assert.equal(app.requests.length, 1)
  app.reply(0)
  await pending
  const row = app.row('longmei')
  assert.match(app.text(row), /状态：正常来源：codex-cli耗时：12.3 秒/)
  assert.match(app.text(row), /输入 \/ 缓存 \/ 输出 token：32500 \/ 28000 \/ 900/)
  assert.equal(app.text(app.find(row, node => node.props.className === 'tac-text')), '原话\n第二行 <script>不执行</script>')
  assert.equal(app.find(row, node => node.props.dangerouslySetInnerHTML), undefined)
})
await test('null_usage_hides_token_row', async () => {
  const app = harness(); app.input('测试')
  const pending = app.pick('cat'); app.reply(0, { usage: null }); await pending
  assert.equal(app.find(app.row('cat'), node => node.props.className === 'tac-usage'), undefined)
  assert.doesNotMatch(app.text(app.row('cat')), /token/)
})
await test('http_401_is_login_error_not_member_speech', async () => {
  const app = harness(); app.input('测试')
  const pending = app.pick('longmei'); app.reply(0, { error: 'unauthorized' }, 401); await pending
  assert.match(app.text(app.row('longmei')), /请求错误提示：请先登录 DSH/)
  assert.doesNotMatch(app.text(app.row('longmei')), /来源：|原话/)
})
await test('all_six_host_statuses_and_error_text', async () => {
  const expected = {
    ok: '状态：正常', empty: '她这轮没吐出可读的回答', timeout: '到点被停掉了（进程树已清理）',
    cancelled: '被你手动停了', failed: '她这轮失败了', unavailable: '这一格现在打不通',
  }
  for (const [status, message] of Object.entries(expected)) {
    const app = harness(); app.input('测试')
    const pending = app.pick('longmei'); app.reply(0, { status, error: status === 'ok' ? null : '错误原文\n下一行' }); await pending
    assert.ok(app.text(app.row('longmei')).includes(message))
    if (status !== 'ok') {
      assert.match(app.text(app.row('longmei')), /错误原文\n下一行/)
      assert.doesNotMatch(app.text(app.row('longmei')), /原话/)
    }
  }
})
await test('cancel_same_id_waits_for_original_response', async () => {
  const app = harness(); app.input('测试')
  const pending = app.pick('longmei'); const stopping = app.stop('longmei')
  assert.equal(app.requests[1].url, '/api/three-agent-chat/ask?action=cancel')
  assert.deepEqual(app.requests[1].body, { requestId: app.requests[0].body.requestId })
  app.requests[1].reply({ cancelled: true }); await stopping
  assert.match(app.text(app.row('longmei')), /停止请求已确认/)
  assert.doesNotMatch(app.text(app.row('longmei')), /被你手动停了|状态：正常/)
  app.reply(0, { status: 'cancelled', text: '' }); await pending
  assert.match(app.text(app.row('longmei')), /状态：被停.*被你手动停了/)
})
await test('three_members_independent_and_late_cancel_cannot_overwrite_new_run', async () => {
  const app = harness(); app.input('测试')
  // DeepSeek Harness那一格不走 HTTP（走会话本体），所以这里的请求只剩Codex CLI和Antigravity；
  // 到这一行的序列是：① Codex CLI ② Antigravity ③ 停Codex CLI（cancel，带的是 requestId 不是 member）④ Codex CLI重来。
  const old = app.pick('longmei'); const cat = app.pick('cat'); const fish = app.pick('dafish')
  const stopping = app.stop('longmei')
  assert.deepEqual(app.requests.map(req => req.body.member ?? null).slice(0, 3), ['longmei', 'cat', null])
  step('① 建好三个点名 + 一个停止请求')
  app.reply(1, { text: 'Antigravity原话' }); await cat
  step('② Antigravity回包已收')
  assert.match(app.text(app.row('longmei')), RUNNING)
  app.reply(0, { status: 'cancelled' }); await old
  step('③ Codex CLI旧调用已收尾')
  const newer = app.pick('longmei')
  step('④ Codex CLI重来已发起，请求数=' + app.requests.length + '，返回值是 Promise 吗=' + (typeof newer?.then === 'function'))
  assert.equal(app.requests.length, 4)
  assert.notEqual(app.requests[3].body.requestId, app.requests[0].body.requestId)
  app.reply(2, { cancelled: true }); await stopping
  step('⑤ 停止请求已确认')
  assert.match(app.text(app.row('longmei')), RUNNING)
  step('⑥ Codex CLI那行还在等')
  assert.doesNotMatch(app.text(app.row('longmei')), /停止请求已确认|被你手动停了/)
  step('⑦ 停止提示没写进那一行')
  app.reply(3, { text: '新回答' }); await newer
  step('⑧ Codex CLI新回答已收')
  app.pushEvent({ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'DeepSeek Harness回答' }] } } })
  await fish
  assert.match(app.text(app.row('longmei')), /新回答/)
  assert.match(app.text(app.row('cat')), /Antigravity原话/)
  assert.match(app.text(app.row('dafish')), /DeepSeek Harness回答/)
})
await test('stale_answer_id_or_wrong_member_never_shown', async () => {
  for (const bad of [{ requestId: 'old-request' }, { member: 'cat' }]) {
    const app = harness(); app.input('测试')
    const first = app.pick('longmei'); app.reply(0); await first
    const newer = app.pick('longmei')
    app.reply(1, { ...bad, text: '旧回答不许展示' }); await newer
    assert.doesNotMatch(app.text(app.row('longmei')), /旧回答不许展示/)
    assert.match(app.text(app.row('longmei')), /身份或 requestId 不匹配/)
  }
})
await test('cancel_false_or_error_allows_retry_and_preserves_running', async () => {
  for (const status of [200, 401, 503]) {
    const app = harness(); app.input('测试')
    const pending = app.pick('cat'); const stop = app.stop('cat')
    app.requests[1].reply({ cancelled: false, error: '取消服务不可用' }, status); await stop
    assert.equal(app.button('cat', '停止').props.disabled, false)
    assert.match(app.text(app.row('cat')), RUNNING)
    app.reply(0); await pending
  }
})
await test('http_409_503_and_network_errors_are_explicit', async () => {
  for (const status of [409, 503, 0]) {
    const app = harness(); app.input('测试'); const pending = app.pick('cat')
    if (status) app.reply(0, { error: '服务缺失' }, status)
    else app.requests[0].reject(new Error('网络断开'))
    await pending
    assert.match(app.text(app.row('cat')), /请求错误提示：/)
    assert.doesNotMatch(app.text(app.row('cat')), /原话|状态：正常/)
  }
})
await test('fixed_panel_and_scrollable_multiline_body_preserved', async () => {
  const app = harness()
  const css = app.text(app.find(app.tree(), node => node.type === 'style'))
  for (const value of ['position:fixed', 'width:440px', 'max-height:calc(100vh - 96px)', 'white-space:pre-wrap', 'overflow:auto']) assert.ok(css.includes(value))
})
console.log(JSON.stringify({ offline: true, realCliRuns: 0, passed: results.length, assertions: results }, null, 2))
