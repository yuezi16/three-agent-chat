/**
 * 一次性诊断脚本：开一个隔离的浏览器窗口，读 DSH 网页里的控制台报错。
 *
 * 为什么要它：面板的注册被运行时的「报错保护」退位了（occupant 还在、active 变 false），
 * 报错原文只存在于浏览器控制台里，命令行拿不到。这里用 DevTools 协议的
 * Runtime.consoleAPICalled / Runtime.exceptionThrown 把原文抓回来。
 *
 * 用法：node browser-console-probe.mjs [页面地址] [秒数]
 * 用完自己关窗口，不碰主人正在用的浏览器。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ARG = process.argv[2] || 'http://127.0.0.1:3080/'
const WAIT_SECONDS = Number(process.argv[3] || 25)
const PORT = 9229
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const profile = mkdtempSync(join(tmpdir(), 'tac-probe-'))
const child = spawn(EDGE, [
  '--user-data-dir=' + profile,
  '--remote-debugging-port=' + PORT,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--new-window',
  URL_ARG,
], { detached: false, stdio: 'ignore' })

let ws = null
const records = []

function done(code) {
  try { ws?.close() } catch {}
  try { child.kill() } catch {}
  setTimeout(() => {
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
    process.exit(code)
  }, 800)
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

async function waitForPage() {
  const started = Date.now()
  while (Date.now() - started < 20000) {
    try {
      const list = await targets()
      const page = list.find(t => t.type === 'page' && /127\.0\.0\.1:3080/.test(t.url))
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await new Promise(r => setTimeout(r, 400))
  }
  return null
}

const page = await waitForPage()
if (!page) {
  console.log('PROBE FAIL：没能连上浏览器调试口（窗口可能没起来）')
  done(2)
}

ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
function send(method, params) {
  ws.send(JSON.stringify({ id: ++id, method, params }))
}

const scriptText = `(() => {
  try {
    const r = window.__ModuleLoader__;
    if (!r) return ['没有 __ModuleLoader__'];
    const out = [];
    out.push('registry keys: ' + Object.keys(r).join(', '));
    for (const k of Object.keys(r)) {
      try {
        const v = r[k];
        if (v && typeof v === 'object' && 'three-agent-chat' in v) out.push('registry.' + k + ' 里有 three-agent-chat');
      } catch (e) { out.push('registry.' + k + ' 读不了: ' + e.message) }
    }
    return out;
  } catch (e) { return ['探针自己出错: ' + e.message] }
})()`

const consoleLines = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data))
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ')
    consoleLines.push('[console.' + msg.params.type + '] ' + text)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {}
    consoleLines.push('[异常] ' + (d.exception?.description || d.text || JSON.stringify(d)))
    if (d.stackTrace?.callFrames?.length) {
      consoleLines.push('[栈] ' + d.stackTrace.callFrames.slice(0, 4).map(f => `${f.functionName || '(匿名)'}@${f.url}:${f.lineNumber + 1}`).join(' <- '))
    }
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry
    consoleLines.push('[log.' + e.level + '] ' + e.text + (e.url ? ' @ ' + e.url : ''))
  }
  if (msg.id === 99) {
    consoleLines.push('[模块表] ' + JSON.stringify(msg.result?.result?.value ?? msg.result))
  }
})

await new Promise((resolve) => {
  ws.addEventListener('open', () => {
    send('Runtime.enable', {})
    send('Log.enable', {})
    // 页面早已加载完，这里读一遍模块表（注册信息不依赖报错事件）
    send('Runtime.evaluate', { expression: scriptText, returnByValue: true, awaitPromise: false })
    send('Page.enable', {})
    send('Page.reload', { ignoreCache: true })
    setTimeout(resolve, WAIT_SECONDS * 1000)
  })
})

console.log('=== 页面：' + page.url + ' ===')
if (consoleLines.length === 0) console.log('（这段时间没有控制台输出和异常）')
for (const line of consoleLines.slice(-60)) console.log(line)
console.log('=== 共 ' + consoleLines.length + ' 条 ===')
done(0)
