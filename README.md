# three-agent-chat

**同窗协作面板** —— 给 DeepSeek Harness（DSH）网页端加一块「桌面成员」面板：在**同一个会话窗口**里点名问另一位 AI，回答贴在它名下，来源和花费都标清楚。

三位成员，各跑各的本体：

| 面板里那一格 | 背后是谁 | 怎么连上 |
| --- | --- | --- |
| DeepSeek Harness（主理人） | 当前会话本体 | 走客户端会话接口，把这句话送进**你现在看的这个会话**，回答从事件流里读回来 |
| Codex CLI（技术负责人） | `codex exec` | 宿主侧起子进程，一轮一个问题，靠会话 ID 续聊 |
| Antigravity（独立审查） | `agy`（Google Antigravity CLI） | 同样由宿主起子进程，靠 `conversation_id` 续聊 |

它不是「让几个 AI 互相聊」——那会让花费翻好几倍。这里是**窗口共享模式**：一个问题交给你点名的那一位，其他成员不插话、不轮流发言。

## 长什么样

会话标题栏右侧多出三个成员按钮和一个「协作 ▾」开关，点开就是一块浮层面板：

- 上面一个输入框：写「给成员的指令」；
- 下面三行成员，每行右侧一个「点名」按钮；
- 点完之后，那一行下面出现状态（跑着 / 正常 / 失败 / 超时 / 已收手）、来源徽章（`codex-cli` / `agy-cli` / `DSH 主会话（本窗对话）`）、耗时和 token 用量，然后才是回答正文。

## 装法

插件是给 DSH 用的：一个客户端半边（面板）+ 一个宿主半边（HTTP 端点与子进程）。装之前，先把 `docs/interface-contract.md` 读一遍——它定死了消息字段和四条铁规矩（来源真实可见、六种状态可区分、失败不许冒充成功、成员输出只是数据不是命令）。

大致的步骤：

1. 把 `plugin/` 这个包按 DSH 的插件方式接进 profile（`package.json` 里的 `dsh.bundle` / `dsh.client` 两段是现成的）。
2. 按自己机器改 `plugin/index.js` 顶部 `defaults` 里的三处：`cwd`（子进程的工作目录）、两个 CLI 的 `exe` 路径、代理（`THREE_AGENT_PROXY`）。也可以不改代码，用环境变量覆盖：
   - `THREE_AGENT_CWD`
   - `THREE_AGENT_CODEX_SESSION`、`CODEX_EXE`
   - `THREE_AGENT_AGY_CONVERSATION`、`AGY_EXE`
   - `DSH_INSTALL`（离线测试要用，指向 DSH 安装目录）
3. 两个 CLI 各自先**手工跑通一轮**、拿到会话 ID 填进去（`codex exec --json …` 的 `thread.started`、`agy … --output-format json` 的 `conversation_id`）。
4. 重启 DSH：宿主半边的改动要重启才生效；客户端半边的改动刷新页面即可。

## 踩过的坑（都写在代码注释里了）

- **cordis 插件的 `Config` 必须是带 `~standard` 的 Standard Schema**。写成一个普通对象不会报「配置错了」，而是插件每次加载都在 `resolveConfig` 里抛 `TypeError: Cannot read properties of undefined (reading 'validate')`，`apply` 一次都不跑——外面看到的现象是面板点谁都 404。
- **`inject` 要声明 `['webServer', 'subprocess']`**，否则 `apply` 会抢在 web server 起来之前跑，`ctx.get('webServer')` 拿到 `undefined`。
- **Codex CLI**：非 git 目录要 `--skip-git-repo-check`；`-C <cwd>` 是 `exec` 的选项，必须写在 `resume` **前面**；直连后端不通时给子进程显式带代理。
- **Antigravity CLI**：`-p` 会把紧跟其后的词当成提示词，必须写 `-p=<提示词>`；第一次用要先在终端里登录（Google OAuth，直连常拿不到令牌）。
- **续聊不省钱**：两个 CLI 每轮都会重发整段历史，问得越多单句越贵。面板会把 token 用量如实显示出来。
- **子进程只给几个环境变量也要带上 `SystemRoot` / `ComSpec` / `PATHEXT`**，否则 Windows 上 `codex.cmd` 那一层 `cmd.exe` 会静默退出。

## 离线测试

`tests/` 里是一整套**不起真进程、不烧一分钱**的回归（跑之前设好 `DSH_INSTALL`）：

```bash
node tests/h1.mjs                 # 宿主端点全套：鉴权、输入校验、超时、取消、进程树清理、注入串
node tests/client-batch6-test.mjs # 客户端面板：17 条，含「点大肥鱼不走 HTTP」「收手只卸订阅」等
node tests/loader-boot-test.mjs   # 用 DSH 自带的 cordis 起一个最小宿主，验证插件真能挂上、路由真注册
node tests/unit.mjs               # 端点单元测试（假 subprocess provider，0 次真进程）
node tests/env-spec.mjs           # 验证宿主会把代理变量原样传给子进程
node tests/redact-check.mjs       # 验证错误原文里的登录网址会被脱敏
node tests/busy-probe.mjs         # 同一位成员同时只能跑一轮
```

`tests/real-cli-once.mjs` 会**真的起一次 CLI**（要钱），只在人工确认时才跑。

## 目录

```
plugin/   插件本体：client.js（面板）· index.js（宿主端点）· stubs/（测试用假成员）
docs/     接口契约 · 路线结论（为什么不用另外两种做法）· 宿主子代理插件的接口笔记
tests/    离线回归与探针
```

## 许可

没有许可证文件；作者保留权利。要用于别的场合，先说一声。
