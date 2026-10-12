// loader-boot-test.mjs —— 离线核一件事：插件的 `inject` 声明，在真的 cordis 里到底管不管用。
//
// 为什么要有它（2026-10-12 18:1x）：
//   主人的面板在两次重启后仍报「宿主端点没注册上（404）」。我在 index.js 顶部加了
//   `export const inject = ['webServer', 'subprocess']`，但也只是「照文档加」——没人证明过
//   这个导出会被 loader 读进去、并在服务就位之后才调 apply。这个脚本就是在真 cordis 里复现一遍：
//     ① 先提供一个依赖、缺另一个 → 断言 apply **没有**跑、路由没注册；
//     ② 第二个依赖也提供 → 断言 apply 跑了、`/api/three-agent-chat/ask` 这条路由真注册上。
//   都过，才说明「inject 声明」这条路是通的；那主人的 404 就只能是别的因（比如进程没真重启）。
//
// 踩过的两个坑（别重复犯）：
//   1. `import()` 在 Windows 上必须用 `pathToFileURL(...).href`，直接给 `E:\...` 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
//   2. 光有 `new Context()` 是**没有 root fiber** 的：在里面 `ctx.plugin(x)` 拿到的 fiber 状态是 0（永不激活）。
//      本文件的做法 = 先用一个空插件占住 root（它就成了 root fiber），剩下的都从它内部去挂。
// 只跑离线假服务，不起任何真进程、不碰网络。
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginIndex = pathToFileURL(resolve(here, '..', 'plugin', 'index.js')).href

// 借用 DSH 自己装的那份 cordis（版本与宿主一致），别引新依赖。
// DSH 装在哪就把 DSH_INSTALL 指向它；不设则用下面这条示例路径。
const dshHome = process.env.DSH_INSTALL || 'C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh'
const require = createRequire(dshHome + '/node_modules/@deepseek-ai/cordis/package.json')
const { Context, Service } = require('./lib/index.js')

const plugin = await import(pluginIndex)
console.log('插件导出：inject =', JSON.stringify(plugin.inject), '| apply 是函数 =', typeof plugin.apply)

const results = []
function report(name, pass, detail = '') {
  results.push({ test: name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`)
}

// ── 假服务：只记下谁注册了什么路由 / 谁想 spawn ─────────────────────
const registered = []
const spawnCalls = []
class FakeWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
  }
  register(route) {
    registered.push(route)
    return () => {
      const i = registered.indexOf(route)
      if (i >= 0) registered.splice(i, 1)
    }
  }
}
class FakeSubprocess extends Service {
  constructor(ctx) {
    super(ctx, 'subprocess')
  }
  spawn(spec) {
    spawnCalls.push(spec)
    throw new Error('离线测试不起真进程')
  }
}

const ctx = new Context()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await ctx.plugin({
  name: 'test-root',
  async apply(root) {
    // ① 先只给 webServer，subprocess 故意留着不给
    root.plugin(FakeWebServer)
    const fiber = root.plugin(plugin)
    await sleep(80)
    report('缺一个依赖时 apply 没有抢先跑', registered.length === 0, `已注册路由数 = ${registered.length}，fiber 状态 = ${fiber.state}`)
    if (registered.length) {
      console.log('  ↑ 如果这里 FAIL，说明这个导出没被 cordis 读进去 —— 那就得在 bundle 的 cordis.patch.yml 里写 inject。')
      return
    }

    // ② 第二个依赖补上 → apply 该动了
    root.plugin(FakeSubprocess)
    await fiber
    await sleep(80)
    const paths = registered.map((r) => `${r.kind} ${r.path}`)
    report('两个依赖齐了路由真注册上', paths.includes('exact /api/three-agent-chat/ask'), `已注册 = ${JSON.stringify(paths)}`)
    report('注册的 handler 是个函数', typeof registered[0]?.handler === 'function')

    // ③ 顺手核一下「离线不许起真进程」这条底线还在不在：这个测试压根不该调 spawn
    report('本测试没有调用 spawn', spawnCalls.length === 0, `spawnCalls = ${spawnCalls.length}`)
  },
})

const failed = results.filter((r) => !r.pass)
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, realCliRuns: 0, hostStarts: 0 }, null, 2))
if (failed.length) process.exit(1)
