/**
 * 「同窗协作面板」客户端半边（跑在网页里）。
 *
 * 干两件事：
 *   1. 在会话头那一格（conversation.session.header.utilities）放一个按钮；
 *   2. 点开下面弹一块面板，列出三位成员（DeepSeek Harness / Codex CLI / Antigravity），
 *      点名通过宿主 HTTP 端点调用，回答与停止操作各自归属于对应成员。
 *
 * 为什么这样注册：槽位可能比插件晚一步声明，所以必须用 slots.inject 包一层
 * （官方模板与 dsh-better-sidebar 生产代码都是这么写的）；order 40 排在自带控件之后。
 */
window.__ModuleLoader__.load({
  id: 'three-agent-chat',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const SLOT = 'conversation.session.header.utilities'
    const RELOAD_HINT = '刷新页面（F5）后再来一次；要是还不行，把浏览器控制台里的红字告诉DeepSeek Harness。'

    /* 报错出口：槽位运行时有一条「渲染崩了就退位」的规矩——这一格一旦抛错，
       会被悄悄摘掉、页面上什么都不剩，报错原文只躺在浏览器控制台里。
       所以这里把控制台里的错捞一份发给宿主，重启后能在日志里看到（不打印主人的对话内容）。 */
    const REPORTED = { done: false }
    function reportClientError(text) {
      if (REPORTED.done || !text) return
      REPORTED.done = true
      try {
        void fetch(ENDPOINT, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ member: '__client__', instruction: '【面板自报】' + inlineText(text), requestId: 'tac-report-' + Date.now(), timeoutMs: 1000 }),
        }).catch(() => {})
      } catch { /* 报不出去也不能把面板再弄崩一次 */ }
    }
    if (typeof window !== 'undefined') {
      const originalError = typeof window.console?.error === 'function' ? window.console.error.bind(window.console) : null
      if (originalError) {
        window.console.error = (...args) => {
          try {
            const text = args.map(value => {
              if (value instanceof Error) return value.message
              if (typeof value === 'string') return value
              try { return String(value) } catch { return '' }
            }).join(' ')
            if (/three-agent-chat|TeamPanel|tac-/.test(text)) reportClientError(text)
          } catch { /* 观察者自己不许崩 */ }
          return originalError(...args)
        }
      }
    }

    const MEMBERS = [
      {
        key: 'dafish',
        name: 'DeepSeek Harness',
        role: '主理人 · DSH 本体',
        tool: '不派工具，直接对话',
        hue: '#c2410c',
        note: '汇总、派活、验收、落盘台账',
      },
      {
        key: 'longmei',
        name: 'Codex CLI',
        role: '技术负责人 · 主代码执行器',
        tool: 'subagent_codex',
        hue: '#1d4ed8',
        note: '写代码、跑命令、交报告',
      },
      {
        key: 'cat',
        name: 'Antigravity',
        role: '交互设计 · 独立审查',
        tool: 'subagent（agy -p）',
        hue: '#047857',
        note: '看界面、挑毛病、只读审查',
      },
    ]

    const ENDPOINT = '/api/three-agent-chat/ask'
    let requestSequence = 0
    const STATUS = {
      ok: ['正常', ''],
      empty: ['空', '她这轮没吐出可读的回答'],
      timeout: ['超时', '到点被停掉了（进程树已清理）'],
      cancelled: ['被停', '被你手动停了'],
      failed: ['失败', '她这轮失败了'],
      unavailable: ['打不通', '这一格现在打不通'],
      stopped: ['已收手', '你自己喊的停——只不再等这次回答，会话没被动过'],
    }

    /* ============ DeepSeek Harness那一格：不经宿主 HTTP 端点，直接走 DSH 客户端接口 ============ */
    /* 为什么要另起一条路：Codex CLI/Antigravity是外部命令行进程，只能由宿主端点的子进程服务去起；
       而DeepSeek Harness就是 DSH 本体（会话自己），网页客户端本来就带着 ctx.sessions 与
       session.prompt()——会话提交的正门，同一个操纵杆。所以这一格用专席接口接进来，
       回答由会话事件（assistant/message）原样读回，不是自建通道、也不冒充别人说话。 */
    let clientCtx = null

    /* 主人那格的助手回答里可能带网址（上游偶发把接口地址贴在正文里）：
       面板只显示前 300 字，网址一律略去，别把面板当日志用。 */
    function inlineText(text) {
      const flat = String(text == null ? '' : text)
        .replace(/https?:\/\/\S+/g, '<网址已省略>')
        .replace(/\s+/g, ' ')
        .trim()
      return flat.length > 300 ? flat.slice(0, 300) + '…' : flat
    }

    function readWindows(binding) {
      const snapshot = binding.eventSource.getSnapshot()
      return Array.isArray(snapshot?.entries) ? snapshot.entries : []
    }

    function replyText(message) {
      const blocks = Array.isArray(message?.content) ? message.content : []
      return blocks
        .filter(block => block && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
        .trim()
    }

    /* 会话回答里的用量字段用的是 DSH 自己的写法（`dsh-llm` 的 TokenUsage：
       inputTokens / cacheReadTokens / cacheWriteTokens / outputTokens）。
       这里同时兼容下划线的旧写法，但**缺项只当 0 显示各自的格子，不整条丢掉**。 */
    function usageOf(usage) {
      if (usage == null || typeof usage !== 'object') return null
      /* 一项一项按名字找，缺项就填 0；三处写法都认：
         DSH 自己的（cacheReadTokens）、下划线的（cached_tokens）、
         以及 codex 那种带上游前缀的（cache_read_input_tokens）。 */
      const firstNumber = (...candidates) => {
        for (const value of candidates) if (Number.isFinite(value)) return value
        return 0
      }
      return {
        inputTokens: firstNumber(usage.inputTokens, usage.input_tokens),
        cachedTokens: firstNumber(usage.cacheReadTokens, usage.cachedTokens, usage.cached_tokens, usage.cache_read_input_tokens),
        outputTokens: firstNumber(usage.outputTokens, usage.output_tokens),
      }
    }

    /* 在会话事件流上等这一轮的回答。收手方式有三条，每条都要收干净：
       ① 出现 baselineSeq 之后的第一条 assistant/message（真回答到手就交）；
       ② turn/end 报错（这轮跑失败，不能干等）；
       ③ signal 断掉（主人点了「收手」，或者整轮被放弃）——这一条要主动卸监听，
          不然 abort 之后这个订阅者会一直挂在会话事件流上，越点越多。 */
    function waitForDshReply(binding, baselineSeq, timeoutMs, signal) {
      return new Promise((resolve, reject) => {
        let settled = false
        let unsubscribe = () => {}
        const timer = setTimeout(() => finish(() => reject(new Error('等回答超时（' + Math.round(timeoutMs / 1000) + ' 秒内没有新回答）'))), timeoutMs)
        const onAbort = () => finish(() => reject(new Error('已收手：不再等这次回答了（会话本身没被动过）。')))
        function finish(action) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unsubscribe()
          signal?.removeEventListener?.('abort', onAbort)
          action()
        }
        function scan() {
          for (const entry of readWindows(binding)) {
            if (entry?.type !== 'event') continue
            const event = entry.event
            if (!event?.seq || event.seq <= baselineSeq) continue
            if (event.type === 'assistant/message') {
              const data = event.data || {}
              const text = replyText(data.message)
              if (text) return finish(() => resolve({ text, usage: usageOf(data.usage), interrupted: data.interrupted === true }))
            }
            if (event.type === 'turn/end') {
              const reason = event.data?.reason || {}
              if (reason.kind === 'error') {
                return finish(() => reject(new Error('这轮跑失败了：' + (reason.error?.message || '未取得原因'))))
              }
            }
          }
        }
        if (signal?.aborted) return finish(() => reject(new Error('已收手：不再等这次回答了（会话本身没被动过）。')))
        signal?.addEventListener?.('abort', onAbort)  // 先挂断线监听，再订阅事件流，中间不留缝
        unsubscribe = binding.eventSource.subscribe(scan)
        scan()
      })
    }

    const DSH_SOURCE = 'DSH 主会话（本窗对话）'

    async function pointAtDsh(sessionId, instruction, signal, requestId) {
      if (!clientCtx?.sessions) throw new Error('拿不到会话服务，面板这一格暂时点不动')
      if (!sessionId) throw new Error('这一格要绑在具体会话上，现在没认出是哪个会话')
      const startedAt = Date.now()
      /* 借现成的会话把手（这个会话本来就是打开状态，主人正看着它）。
         首选 sessions.binding(id)：不延长生命周期、也不用归还；
         取不到再退一步用 using() 借一份（拿到 reference 后先 await ready，
         再用 reference.binding），结尾 release() 还回去。 */
      const borrowed = clientCtx.sessions.binding(sessionId)
      if (borrowed) return runDshTurn(borrowed, instruction, signal, startedAt, requestId)
      return clientCtx.sessions.using(sessionId, { source: 'gateway', signal }, async reference => {
        try {
          await reference.ready
          return await runDshTurn(reference.binding, instruction, signal, startedAt, requestId)
        } finally {
          reference.release()
        }
      })
    }

    async function runDshTurn(binding, instruction, signal, startedAt, requestId) {
      const messages = readWindows(binding)
        .filter(entry => entry?.type === 'event' && entry.event?.type === 'assistant/message')
      const baselineSeq = messages.length ? messages[messages.length - 1].event.seq : 0
      /* 会话自己的「停止」按钮只管会话那一轮，不会断我们这条等回答的链路。
         所以这里自己接管收手：主人的收手信号、或者面板整轮被放弃，都转发到本地控制器，
         等回答那一步据此卸掉订阅——不然会话事件流上会积压一堆没人管的订阅者。 */
      const local = new AbortController()
      const forwardAbort = () => local.abort()
      signal?.addEventListener?.('abort', forwardAbort)
      try {
        const sent = await binding.session.prompt([{ type: 'text', text: instruction }], 'queue', local.signal)
        if (!sent?.ok) throw new Error('这句话没送进会话：' + (sent?.error?.message || '未取得原因'))
        const answer = await waitForDshReply(binding, baselineSeq, 600000, local.signal)
        return {
          member: 'dafish', requestId, status: 'ok',
          text: answer.text + (answer.interrupted ? '\n（这轮被打断，以上是已说出的部分）' : ''),
          source: DSH_SOURCE, startedAt, endedAt: Date.now(), durationMs: Date.now() - startedAt,
          usage: answer.usage, exitCode: null, error: null,
        }
      } finally {
        signal?.removeEventListener?.('abort', forwardAbort)
      }
    }

    /* Codex CLI/Antigravity那一格：走宿主 HTTP 端点（外部命令行由宿主子进程服务起）。
       老写法直接 response.json()，宿主一旦回非 JSON（兜底 404 的 `not found` 之类）
       就抛 "Unexpected token 'o', "not found" is not valid JSON" —— 主人看不懂这句，
       也分不清是不是自己点错了。现在先读原文，是 JSON 才解析，不是就原样报原文。 */
    async function post(url, body, signal) {
      const response = await fetch(url, {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      if (response.status === 401) throw new Error('请先登录 DSH')
      if (response.status === 409) throw new Error('requestId 撞车，请重新点名')
      if (response.status === 404) throw new Error('宿主端点 /api/three-agent-chat/ask 没注册上（插件可能没随 DSH 重启重新加载）')
      const rawText = await response.text()
      let data = null
      try { data = JSON.parse(rawText) } catch { /* 非 JSON：下面按原文报 */ }
      if (!data) throw new Error('宿主回了非 JSON（HTTP ' + response.status + '）：' + rawText.slice(0, 200))
      if (response.status !== 200) throw new Error(data.error || '宿主请求失败（HTTP ' + response.status + '）')
      return data
    }

    function chipButton(m, onClick) {
      return h('button', {
        key: m.key,
        type: 'button',
        title: m.name + ' · ' + m.role,
        onClick,
        style: {
          boxSizing: 'border-box',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          marginRight: 6,
          padding: '2px 9px 2px 7px',
          font: 'inherit',
          fontSize: 12,
          lineHeight: '18px',
          color: 'inherit',
          background: 'transparent',
          border: '1px solid color-mix(in srgb, currentColor 28%, transparent)',
          borderRadius: 999,
          cursor: 'pointer',
        },
      }, h('span', {
        style: {
          width: 7, height: 7, borderRadius: '50%', background: m.hue, display: 'inline-block',
        },
      }), m.name)
    }

    /* 等回答时的「已等 N 秒」读数：另起一个小件专门管计时器，
       这样万一它哪儿不合适，崩的是这一小块，面板本体还在。 */
    function WaitingClock() {
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        let timer = null
        try {
          timer = setInterval(() => setTick(value => value + 1), 1000)
          if (typeof timer?.unref === 'function') timer.unref()
        } catch { /* 计时器起不来只是不刷新秒数，不影响回答 */ }
        return () => { try { clearInterval(timer) } catch { /* 收尾失败无所谓 */ } }
      }, [])
      return null
    }

    const STYLE_TEXT = [
      '.tac-panel{position:fixed;top:52px;right:12px;width:440px;max-width:calc(100vw - 24px);max-height:calc(100vh - 96px);overflow:auto;box-sizing:border-box;z-index:9999;padding:12px 14px;border-radius:12px;font-size:13px;line-height:1.55;color:inherit;background:var(--dsh-color-bg-elevated,#fff);box-shadow:0 12px 32px rgba(0,0,0,.18);border:1px solid color-mix(in srgb, currentColor 18%, transparent);}',
      '.tac-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600;font-size:13px;}',
      '.tac-close{box-sizing:border-box;font:inherit;font-size:12px;padding:2px 8px;color:inherit;background:transparent;cursor:pointer;border:1px solid color-mix(in srgb, currentColor 28%, transparent);border-radius:6px;}',
      '.tac-member{padding:8px 0;border-top:1px solid color-mix(in srgb, currentColor 12%, transparent);}',
      '.tac-row{display:flex;align-items:center;gap:10px;}',
      '.tac-dot{width:8px;height:8px;border-radius:50%;flex:none;}',
      '.tac-who{flex:1;min-width:0;}',
      '.tac-name{font-size:13px;font-weight:600;}',
      '.tac-sub{font-size:12px;opacity:.65;margin-top:2px;}',
      '.tac-pick{box-sizing:border-box;flex:none;font:inherit;font-size:12px;padding:3px 10px;color:inherit;background:transparent;cursor:pointer;border:1px solid color-mix(in srgb, currentColor 35%, transparent);border-radius:6px;}',
      '.tac-note{margin-top:8px;font-size:12px;opacity:.7;}',
      '.tac-input{display:block;box-sizing:border-box;width:100%;min-height:76px;max-height:180px;resize:vertical;font:inherit;color:inherit;background:transparent;margin:6px 0 10px;border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:6px;padding:6px;}',
      '.tac-answer{min-width:0;margin:0 0 4px 18px;font-size:12px;overflow-wrap:anywhere;}',
      '.tac-meta{display:flex;flex-wrap:wrap;gap:4px 12px;opacity:.8;}',
      '.tac-text,.tac-error{white-space:pre-wrap;max-height:220px;overflow:auto;margin-top:4px;}',
      '.tac-pick:disabled{opacity:.5;cursor:default;}',
    ].join('')

    /* 面板本体的安全网：万一某一行渲染抛错，只丢这一块，
       而且把原因直接写在面板上（主人一眼能看见），不是整格悄悄消失。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        try { reportClientError(String(error?.stack || error?.message || error)) } catch { /* 上报失败不影响兜底展示 */ }
      }
      render() {
        if (this.state.error) {
          return h('aside', { className: 'tac-panel', role: 'dialog', 'aria-label': '同窗协作面板（出错了）' },
            h('div', { className: 'tac-head' }, h('span', null, '同窗协作 · 面板出错了')),
            h('div', { className: 'tac-error' }, String(this.state.error?.message || this.state.error)),
            h('div', { className: 'tac-note' }, RELOAD_HINT),
          )
        }
        return this.props.children
      }
    }

    function answer(row) {
      if (!row) return null
      const result = row.result
      const status = result && STATUS[result.status]
      const localStatus = !result && row.status ? STATUS[row.status] : null
      const waited = row.running && Number.isFinite(row.startedAt)
        ? '已等 ' + Math.max(0, Math.round((Date.now() - row.startedAt) / 1000)) + ' 秒' : null
      return h('div', { className: 'tac-answer', 'aria-live': 'polite' },
        h('div', { className: 'tac-status' }, '状态：' + (row.running ? (waited ? '等着回答 · ' + waited : '跑着…') : status ? status[0] : localStatus ? localStatus[0] : '失败')),
        result ? h('div', { className: 'tac-meta' },
          h('span', null, '来源：' + (result.source || '未取得')),
          h('span', null, '耗时：' + (Number.isFinite(result.durationMs) ? (result.durationMs / 1000).toFixed(1) + ' 秒' : '未取得')),
        ) : null,
        result?.usage != null ? h('div', { className: 'tac-usage' },
          '输入 / 缓存 / 输出 token：' + [result.usage.inputTokens, result.usage.cachedTokens, result.usage.outputTokens]
            .map(value => value === null || value === undefined ? '未取得' : value).join(' / ')) : null,
        status?.[1] ? h('div', { className: 'tac-error' }, '状态说明：' + status[1]) : null,
        localStatus?.[1] ? h('div', { className: 'tac-error' }, localStatus[1]) : null,
        result?.error ? h('div', { className: 'tac-error' }, '错误提示：' + result.error) : null,
        row.localError ? h('div', { className: 'tac-error' }, '请求错误提示：' + row.localError) : null,
        result?.status === 'ok' ? h('div', { className: 'tac-text' },
          row.requestId?.startsWith('tac-dsh-') ? inlineText(result.text) : result.text) : null,
        row.notice ? h('div', { className: 'tac-error' }, row.notice) : null)
    }

    function Panel({ instruction, hint, setInstruction, setOpen, rows, pick, stop, stopDsh }) {
      return h('aside', { className: 'tac-panel', role: 'dialog', 'aria-label': '同窗协作面板' },
        h('div', { className: 'tac-head' },
          h('span', null, '同窗协作 · 桌面成员'),
          h('button', { type: 'button', className: 'tac-close', onClick: () => setOpen(false) }, '收起'),
        ),
        h('label', null, '给成员的指令', h('textarea', {
          className: 'tac-input', value: instruction, maxLength: 8000,
          placeholder: '写一句指令，再点对应成员的「点名」',
          onChange: event => setInstruction(event.target.value),
        })),
        hint ? h('div', { className: 'tac-note', role: 'status' }, hint) : null,
        MEMBERS.map(m => memberRow(m, rows, pick, stop, stopDsh)),
        h('div', { className: 'tac-note' },
          '点「点名」发送指令；回答显示在对应成员下方。',
          'Codex CLI / Antigravity由宿主起命令行程序，跑着时可点「停止」；DeepSeek Harness就是你正在聊的这个会话本体，',
          '点「点名」＝把这句话送进本窗对话、等它答完再贴回来（想停就点输入框那边的停止键）。',
        ),
      )
    }

    function openInFlight(rows) {
      return Object.keys(rows).some(key => rows[key]?.running)
    }

    function memberRow(m, rows, pick, stop, stopDsh) {
      return h('div', { key: m.key, className: 'tac-member' },
        h('div', { className: 'tac-row' },
          h('span', { className: 'tac-dot', style: { background: m.hue } }),
          h('div', { className: 'tac-who' },
            h('div', { className: 'tac-name' }, m.name + ' · ' + m.role),
            h('div', { className: 'tac-sub' }, m.note + '　｜　通道：' + m.tool)),
          h('button', { type: 'button', className: 'tac-pick', disabled: !!rows[m.key]?.running, onClick: () => pick(m) }, '点名'),
          rows[m.key]?.running && m.key === 'dafish'
            ? h('button', { type: 'button', className: 'tac-pick', onClick: () => stopDsh(m) }, '收手')
            : null,
          rows[m.key]?.running && m.key !== 'dafish'
            ? h('button', { type: 'button', className: 'tac-pick', disabled: !!rows[m.key]?.stopping, onClick: () => stop(m) }, '停止')
            : null),
        answer(rows[m.key]))
    }

    function TeamPanel(props) {
      const sessionId = props?.sessionId
      const [open, setOpen] = React.useState(false)
      const [instruction, setInstruction] = React.useState('')
      const [hint, setHint] = React.useState('')
      const [rows, setRows] = React.useState({})
      /* Ref 同步拦住连续点击；异步回包和 state 更新都按 requestId 核对。 */
      const active = React.useRef({})

      function update(key, requestId, patch) {
        if (active.current[key]?.requestId !== requestId) return
        setRows(previous => previous[key]?.requestId === requestId
          ? { ...previous, [key]: { ...previous[key], ...patch } } : previous)
      }

      /* DeepSeek Harness那一格：把指令送进「就是你现在看的这个会话」，等真回答。
         走的是 DSH 客户端自己的会话接口（ctx.sessions.using + session.prompt），
         不是自建的后门，也不冒充别人。 */
      async function pickDsh(m, instruction) {
        const requestId = 'tac-dsh-' + Date.now() + '-' + (++requestSequence)
        const run = { requestId, running: true, stopping: false, controller: new AbortController() }
        active.current[m.key] = run
        setHint('')
        setRows(previous => ({
          ...previous,
          [m.key]: { requestId, running: true, startedAt: Date.now(), notice: '已把这句话送进当前会话，等这次回答说完…' },
        }))
        try {
          const result = await pointAtDsh(sessionId, instruction, run.controller.signal, requestId)
          if (result.requestId !== requestId || result.member !== m.key) {
            throw new Error('回答归属核对不通过，未展示')
          }
          update(m.key, requestId, { running: false, result, notice: '' })
        } catch (e) {
          /* 是「主人自己点了收手」就别再写一行错误：那句话本来就说清楚了，
             错误提示只会把「已收手」顶掉，屏幕上剩一个光秃秃的「状态：失败」。 */
          const byHand = String(e?.message || e).includes('已收手')
          update(m.key, requestId, byHand
            ? { running: false, status: 'stopped', localError: '' }
            : { running: false, localError: String(e?.message || e), notice: '' })
        } finally {
          if (active.current[m.key] === run) run.running = false
        }
      }

      async function pick(m) {
        if (!instruction.trim()) { setHint('请先写一句指令'); return }
        if (active.current[m.key]?.running) { setHint(m.key === 'dafish' ? 'DeepSeek Harness还在答上一句，等它答完。' : '这位成员还在答上一句，等它答完再点名。'); return }
        if (m.key === 'dafish') return pickDsh(m, instruction.trim())
        const requestId = 'tac-' + Date.now() + '-' + (++requestSequence)
        const run = { requestId, running: true, stopping: false }
        active.current[m.key] = run
        setHint('')
        setRows(previous => ({
          ...previous,
          [m.key]: {
            requestId, running: true, startedAt: Date.now(),
            notice: '',
          },
        }))
        try {
          const result = await post(ENDPOINT, { member: m.key, instruction, requestId, timeoutMs: 120000 })
          if (result.requestId !== requestId || result.member !== m.key) {
            throw new Error('宿主响应身份或 requestId 不匹配，未展示回答')
          }
          if (!Object.prototype.hasOwnProperty.call(STATUS, result.status)) throw new Error('宿主返回了未知状态')
          update(m.key, requestId, { running: false, result, notice: '' })
        } catch (e) {
          update(m.key, requestId, { running: false, localError: String(e.message || e), notice: '' })
        } finally {
          if (active.current[m.key] === run) run.running = false
        }
      }

      /* DeepSeek Harness那格的「停止」＝收手，不去动主人正在跑的对话。
         理由：它的回答就是本窗对话自己产出的，能停它的只有会话的 cancel()，
         而那个 cancel() 会把主人当前这一轮也一起停掉——那个按钮该由输入框旁边
         自带的停止键来管，不放在这块面板上。 */
      function stopDsh(m) {
        const run = active.current[m.key]
        if (!run?.running || run.stopping) return
        run.stopping = true
        run.controller.abort()
        /* localError 一起清掉：收手是主人自己的动作，屏幕上该写「已收手」，不该留一行「状态：失败」。 */
        update(m.key, run.requestId, { localError: '', notice: '已收手：不再等这次回答了（会话本身没被动过）。' })
      }

      async function stop(m) {
        const run = active.current[m.key]
        if (!run?.running || run.stopping) return
        run.stopping = true
        update(m.key, run.requestId, { stopping: true, notice: '正在请求停止…' })
        try {
          const result = await post(ENDPOINT + '?action=cancel', { requestId: run.requestId })
          if (typeof result.cancelled !== 'boolean') throw new Error('宿主停止响应格式错误')
          if (run.running) update(m.key, run.requestId, {
            notice: result.cancelled ? '停止请求已确认，等待原调用返回…' : '未确认停止，等待原调用返回；可重试停止。',
          })
          if (!result.cancelled) run.stopping = false
        } catch (e) {
          run.stopping = false
          if (run.running) update(m.key, run.requestId, { notice: '停止错误提示：' + String(e.message || e) })
        } finally {
          if (run.running) update(m.key, run.requestId, { stopping: run.stopping })
        }
      }

      return h(React.Fragment, null,
        h('span', { style: { display: 'inline-flex', alignItems: 'center' } },
          MEMBERS.map((m) => chipButton(m, () => setOpen(true))),
          h('button', {
            type: 'button',
            title: '展开/收起同窗协作面板',
            onClick: () => setOpen(!open),
            style: {
              boxSizing: 'border-box',
              font: 'inherit', fontSize: 12, padding: '2px 8px', color: 'inherit',
              background: 'transparent', cursor: 'pointer',
              border: '1px solid color-mix(in srgb, currentColor 28%, transparent)', borderRadius: 6,
            },
          }, open ? '收起 ▴' : '协作 ▾'),
        ),
        h('style', null, STYLE_TEXT),
        open ? h(PanelBoundary, null,
          openInFlight(rows) ? h(WaitingClock) : null,
          h(Panel, { instruction, hint, setInstruction, setOpen, rows, pick, stop, stopDsh }),
        ) : null,
      )
    }

    return {
      /* 槽位由 ui-conversation 声明；用 inject 包一层，声明重挂时回调会重跑。
         sessions：DeepSeek Harness那一格要借会话自己的提交口（panel 里点「点名」＝把话送进当前会话）。 */
      inject: ['slots', 'sessions'],
      apply(ctx) {
        clientCtx = ctx
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: 'three-agent-chat:panel',
          order: 40,
          registrant: 'three-agent-chat',
        }, TeamPanel))
      },
    }
  },
})
