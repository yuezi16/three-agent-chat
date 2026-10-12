# T-025 batch 1：路线结论

2026-10-12。第 1 批仅交接口清单与本结论，不含探针或实现代码。
证据路径缩写 P/W/F 与同目录 `interface-list.md` 完全一致。

## 结论

**接口层面有可行路径，优先 B：DSH 自定义协作面板；真实三方群聊端到端仍未验证。**
这是基于已查接口作出的工程建议，不是实测成功声明：客户端 Slot 已有头部入口样板，宿主有 HTTP/会话跟随与 subprocess 接缝；可以把各真实来源的原文在一个新面板内汇合。证据见接口清单1、3、4节。
“最省事”指满足三方原文与明确来源的最短已知实现路径；不是已测工期。A 的外部成员接口未查实，C 的默认回传方式不是群聊气泡，均不适合先承诺直接复用原聊天流。

## 三条候选路线

下表的路径都是**未来建议新增模块**，不是已找到的现成文件，也不是本批授权修改范围。安装/配置由DeepSeek Harness后续执行，本批未动。

| 路线 | 未来需要哪些文件 / 模块 | 卡点与证据 | 粗估规模（工程估算，未验证） |
| --- | --- | --- | --- |
| A 修改 DeepSeek-Bot | 需要该插件真实源码中的成员执行适配、调度、消息写入与取消模块，另加 CLI 适配器；具体文件名未验证，不能编造 | 原方案 `W/projects/agent-team/sandbox/three-agent-chat-plan-20261012.md:20` 自己也标外部 CLI 成员未证实；101仅给网络 README 地址。本批不联网，没有获准读取的 Bot 实现证据。不能把 DSH Agent Teams 等同于 DeepSeek-Bot | 无法负责任给出数值；可能仅适配，也可能改核心。必须先取得本地源码才估算。A 未被证明不可行，当前只是不具备推荐依据 |
| B DSH 自定义协作面板（推荐） | 建议未来 `src/three-agent-chat/package.json`、`host.ts`、`client.tsx`、`queue.ts`、`codex-adapter.ts`、`agy-adapter.ts`、`store.ts`、`README.md`，对应模拟测试；DeepSeek Harness安装包并登记 bundle | Slot 样板 `P/dsh-experimental-client-ui-agent-team/lib/client.js:491–497`；webServer register `P/dsh-host-webserver/lib/types/index.d.ts:90`；SessionController follow `P/dsh-api-session-controller/lib/types/index.d.ts:196`；subprocess spawn `P/dsh-subprocess/lib/types/index.d.ts:102`。仍需接好宿主/客户端加载、来源记录、认证与取消、恢复存储 | 中等：约8–12个实现/说明文件、800–1600行，另200–500行有意义的模拟测试；非工期承诺。以队列、双适配器、存储和界面模块数量为估算依据，接口探针后重估 |
| C 外部 CLI 做 DSH 子代理提供者 | 建议未来 `codex-provider.ts`、`agy-provider.ts`、provider 注册入口与包配置、CLI 会话映射；若要求三方平铺仍需面板或消息渲染接入 | one-shot 的 `run.result.output` 返回工具结果（`P/dsh-tool-subagent/lib/index.js:314–324`）；continuable 要 prepareContinuable，且该扩展只贡献 seed、不接管 CLI turn（`P/dsh-subagent/lib/types/types.d.ts:220–231,361–375`）。团队 spawn 依赖 startContinuable（团队实现573–575） | 仅工具回传：小到中等，约4–7文件、300–700行；满足完整群聊还需额外界面/驱动，不能按此小规模报价。官方 Codex provider 内部本批未验证，不能承诺直接复用全部实现 |

## 哪条被证据否掉了

否掉的是 **C 的“只注册外部 provider，就自动得到持续团队成员和主聊天流独立发言”这一简化版本**，不是所有 C 方案：

1. one-shot provider 的结果由工具层收取并返回 kind=foreground/runId/output；这是工具调用路径，不能代表原生群聊成员气泡。证据：工具实现314–324，Agent loop 697 写 tool/result。
2. 团队成员创建走 startContinuable；无 prepareContinuable 明确抛 UNSUPPORTED_CAPABILITY。证据：团队实现573–575，subagent 实现3149–3152。
3. 即使补上 prepareContinuable，其契约只返回 seed，后续 Agent/turn/恢复由宿主管理，并非把消息转发给 CLI 的回调。证据：subagent types.d.ts 220–231、361–375。因此“加一个方法就复用 codex exec/agy 的持续对话”不成立。
4. 团队 sendMessage 的 senderId/name 来自 caller/membership；接收事件为 source.kind=team-message 的 user/message。证据：团队 mailbox.js 58–60、98、114–115。不能用DeepSeek Harness caller 发送外部文字，再声称它是Codex CLI的真实团队身份。

A 只判“未验证”，不能用没找到接口当作不存在的证据。
B 也不声称原有聊天页已支持三位助手：它是同一个 DSH 窗口里的新协作面板，需要自己记录可追溯的 CLI 来源。

## 五个问题的直接回答

- **能以成员名义落会话吗？** 已注册真实 Team 成员可通过 sendMessage 保留 senderId/name，并落目标 user/message；未发现“任意外部 CLI 输出→主会话原生成员助手气泡”的现成证明。agents 管生命周期，agentTeams 管成员/邮箱，subagents 管委派，三者不能混为一个接口（接口清单1–2节）。
- **宿主怎么起进程、超时和收输出？** subprocess.spawn 显式 argv/cwd/stdio/graceMs/signal/env，句柄 pipe 或 collected.readFrom，done 后仍应按需要 waitForExit；超时由调用方拥有，Windows 终止路径有 Job 与 taskkill 后备，实际清树未验证（接口清单3节）。
- **独立代理环境可行吗？** 接口和本机桥配置均支持子进程 env 三项覆盖，无须修改全局；本批没有真起网络子进程，插件透传与网络连通未验证（接口清单3节）。
- **不改 apps/web 能加区域吗？** 正规 Slot 客户端插件路径已有实现证据；头部动作可作为新面板入口。webServer 路由可配套提供数据/资源，tapIndex 不是做面板的必要条件（接口清单4节）。
- **CLI 能续聊吗？** 本机 Codex 0.162.1 帮助明确列 exec resume，agy 帮助列 --conversation；实际两轮续聊未验证。已不满足“都没有”的前提；回填历史的假设成本公式和示例在接口清单6节。

现成插件的一句话结论：本机配置把 codex provider 连成 one-shot 工具，通用工具层将 result.output 交回；该 Codex 插件内部怎样驱动 CLI **未验证**，因为本单读取白名单与样板要求冲突（接口清单5节）。

## 第 2 批前的待查事项（本批不执行）

1. 给 Codex 插件包源码明确只读范围，核对它真正使用的协议、流式输出、持久线程和取消方法；需要选 A 时另提供 DeepSeek-Bot 本地源码。
2. 用不含秘密的小对话验证 codex exec resume / agy --conversation 的两轮连续性、中文与 stdin 行为；先解决本次 Codex 启动临时目录拒绝，由DeepSeek Harness处理环境，本批没有绕过。
3. 先用模拟进程验证 subprocess 的输出、env、超时/取消/停止后晚到消息，再做有授权的真实 CLI 往返。不能把源码存在当成 Windows 清树实测。
4. 最小客户端插件证明 Slot 面板能加载，跟随DeepSeek Harness真实会话；记录每条 source/member/sessionId/requestId 与状态，失败不能由其他模型冒充。随后再定最终模块数和工期。

## 实际验证与限制

已执行命令和关键实际输出：

```text
codex --version
  codex-cli 0.162.1
codex exec resume --help
  Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
agy --help
  --conversation                  Resume a previous conversation by ID
git -C projects/agent-team status --short
   M TASKS.md
```

源码取证采用 rg -n 和按行编号 Get-Content；完整路径/签名/行号见接口清单，所有推荐都由上述证据推导，规模单独标为估算。
TASKS.md 在开始时已修改，本批没有写它。两份 Markdown 以外未安排写入。

被拒：Codex 启动自带操作报 `WARNING: failed to clean up stale arg0 temp dirs: 拒绝访问。 (os error 5)`，并报无法创建 PATH aliases；完整两条路径见接口清单7节。后续停止 Codex 调用，没有改路径或提权重试。没有 blocked by policy。
命令误定位：工作区根 git 报 `fatal: not a git repository (or any of the parent directories): .git`；不存在的 events.d.ts 报 `系统找不到指定的文件。 (os error 2)`。均保留记录，未当作功能否定依据。
外层 item.status 本轮未取得，需DeepSeek Harness从执行 JSONL 核对；本批证据是命令实际输出、源码定位与两份文件回读，不据 exit 0 宣称端到端验收。

一句话结论：**先走 B 做同窗真实来源展示，C 可作执行层参考；原生三方平铺、插件内部实现与续聊实际效果继续标为未验证。**
