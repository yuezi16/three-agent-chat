用途：记录官方 Codex 插件驱动、输出、线程、取消与环境透传证据。
预计：约 50 行；实际行数交付时统计。
去留：保留作为 B 路线实现依据。
# T-025 第 2 批：插件调查

路径 C = `<DSH_HOME>/profiles/web/node_modules/@deepseek-ai/dsh-subagent-codex/`。
路径 P = `<DSH_INSTALL>/node_modules/@deepseek-ai/`。
以下 C 中源码均为 `lib/index.js`；仅只读，不复制源码。

## 1. 怎么驱动 CLI
- C:577–583 固定启动 Node + 包内 Codex wrapper + `app-server --stdio`，不靠 PATH 中的 codex。
- C:642–651 通过共享 subprocess.spawn 传 argv/cwd/三路 pipe/env。
- C:190–203 做 initialize/initialized 握手；211–219 thread/start；233–240 turn/start。
- 没有走 `codex exec` 或 `exec resume`。本包检索 resume 只命中线程相关说明，无 resume 调用。

## 2. 怎么收输出
- C:659 使用 stdout/stdin 创建 CodexAppServerWire，是 JSON-RPC 帧协议，非一次收集整份 CLI stdout。
- C:458–489 处理通知，答复取 `item/completed` 的 agentMessage，保存 final_answer 或 null phase；commentary 不选作最终答案。
- C:491 起处理 turn/completed；308–310 选择最后一份非 commentary 答案。
- 因此“协议通知连续读取”成立，“逐 token 流式发给面板”不成立：此处理器没有消费 text delta，也没有 --output-format 参数。

## 3. 能不能恢复
- C:211–219 明确 `ephemeral: true`，校验后只放在 wire 实例的 this.threadId。
- C:637、659、710 每次 run 新建连接/线程；不是持久线程 ID 仓库。
- 下一轮不复用这个 ID，也没有 thread/resume；不能直接拿现插件充当多轮群聊适配器。
- 结论仅针对本包实现，不能推导 Codex 本身不支持续聊。

## 4. 怎么取消
- C:696–704 本地 AbortController 标取消并调用 wire.interrupt。
- C:297–302 尝试 turn/interrupt（带 threadId/turnId），失败吞掉；这是尽力通知。
- C:610–629 关闭协议、结束 stdin、child.terminate、waitForExit、等待 done。
- 所以不是只发信号就算收工；本机杀树效果未实测。

## 5. 代理三件套是否透传
- C:844 config.env → spec.env；651 → subprocess.spawn 的 env。
- P/dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js:1516–1521，targetEnvironment 调 childEnv(spec.env)。
- 同文件694–706，先清理父环境再合并 extra；Windows 按大小写不敏感规则覆盖。
- HTTP_PROXY / HTTPS_PROXY / NO_PROXY 若在 config.env 中显式配置，就沿该链进入目标进程；不是仅继承父进程的猜测。
- 本批未读取 profile 其他配置，当前配置值、网络可达与实际子进程环境未验证。

## 面板与后续安装
- 样板 P/dsh-experimental-client-ui-agent-team/package.json:21–23 导出 ./client；30 起声明 dsh.client/platform/inject。
- 样板 lib/client.js:1–7 是 __ModuleLoader__.load 包装；457–461 注入 slots 等服务；491–497 注册 conversation.session.header.actions。
- panel 保留同样包装和槽位。component.js 为组件源与空宿主入口；client.js 内嵌该组件函数，避免浏览器相对 require 无法解析，不需安装构建工具。
- package.json 用前三行自定义元数据满足头部要求，仍是合法 JSON。
- DeepSeek Harness下一步一：把 panel 作为本地包装入 web profile 并登记客户端加载（bundle/插件声明按宿主管理方式）；风险：依赖或装载声明错误会影响插件加载。
- DeepSeek Harness下一步二：重启 DSH 并刷新浏览器，检查会话头“协作面板（演示）”三条假消息；风险：中断正在运行的会话任务，需选空闲时间。
- 本批不安装、不启动；真实加载、布局与宿主兼容性未验证。

## 判断
可参考现成插件的协议解析、取消和 env 通道；持久 ID 映射与续聊仍需单独做。无需重造 subprocess 层。
CLI 首轮初始化遭拒，详见 probe/continuity-results.md；无会话 ID，未进行第二轮或 agy 探测。
item.status：未取得；源码取证和文件落盘不冒充完整验收。
