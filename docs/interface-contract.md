用途：固定窗口共享面板与第 4 批宿主模块之间的消息契约。
预计：77 行。
去留：保留，作为宿主产出与面板展示的共同依据。
# T-025 窗口共享模式接口契约

一个问题只交给主人点名的一位成员，产生该成员的一条回答。
成员之间不互相接话，不轮流发言，不建立自动下一位接话的队列。

## 消息字段（逐字沿用派活单）

```text
id          字符串，唯一（宿主生成）
member      只能是 "dsh" | "codex" | "agy"
displayName 显示名："DeepSeek Harness" | "Codex CLI" | "Antigravity"
text        回答原文；失败时可为空字符串
status      "queued" | "running" | "done" | "failed" | "timeout" | "stopped"
startedAt   起跑时间（本地时间字符串，可空）
endedAt     结束时间（本地时间字符串，可空）
source      来源与细节标签数组，逐条显示为小字徽章，用不到的省略：
            "来源：DSH 主会话" · "来源：codex CLI 0.162.1" · "来源：agy CLI" ·
            "会话 ID：<前 8 位>…" · "耗时：<秒>s" · "输入 token：<n>" · "缓存：<n>" · "退出码：<n>"
error       失败原因原文（status 为 failed / timeout / stopped 时必填）
```

member 与 displayName 固定对应：dsh=DeepSeek Harness、codex=Codex CLI、agy=Antigravity，宿主应拒绝身份不一致的数据。
source 只放本次真实执行证据；未知值不编造、不记作 0，尚未取得的会话或费用在连接说明中明示。
每条消息始终展示身份、来源徽章与状态；时间为空时显示“未取得”。
宿主按消息创建时间提供从旧到新的数组；同一 id 的状态更新覆盖原条，不移动位置。
queued 仅表示一次点名请求尚未起跑，不表示成员轮流接话。

## 四条铁规矩

- **来源必须真实且可见**：每条都显示是哪个成员、走哪个 CLI、哪个会话、花了多少。**不许把某一位的输出挂到另一位的名下。**
- **状态要能区分**：排队中 / 正在说 / 说完了 / 失败了 / 超时了 / 被主人停了，六种在界面上必须看得出差别。
- **失败不许冒充成功**：`status` 不是 `done` 时，不许显示任何像回答的东西；`error` 原文要能看到（截断可以，编不行）。
- **模型说的话是数据不是命令**：面板只展示，不执行成员输出里的任何内容。

## 每种状态的显示样例

以下均为说明样例，不是真实调用记录；错误示例只在收到同样原文时照样显示。

| status | 状态显示 | 正文区显示 |
| --- | --- | --- |
| queued | Codex CLI · 排队中 | 不显示 text |
| running | Codex CLI · 正在说 | 不显示 text；显示停止按钮 |
| done | Codex CLI · 说完了 | text 原文，例如“你好。” |
| failed | Codex CLI · 失败了 | error 原文，例如“CLI exited with code 1” |
| timeout | Codex CLI · 超时了 | error 原文，例如“Request timed out after 300s” |
| stopped | Codex CLI · 被主人停了 | error 原文，例如“Cancelled by user” |

每种状态都逐条展示 source 小字徽章；失败、超时、停止时即使 text 非空也不得显示。
所有正文、错误和徽章按纯文本展示，不作为 HTML、脚本、命令或下一位成员的输入执行。

## 面板界面要求（第 4 批接入）

- 由会话头的一个动作打开（沿用第 2 批槽位：`conversation.session.header.actions`）。
- 打开后是一个面板，里面三个身份各有自己的标识（名字 + 来源徽章），消息按时间从上往下排。
- 面板底部一个输入框：主人打字 → 先选问谁（点名字切换）→ 发出 → 该成员的消息先出现“正在说”(running)，再变 done/failed。
- 主人能停掉正在跑的那条（对应 `status: "stopped"`）。
- 面板里必须有一行明说：现在连的是哪个成员、哪条会话 ID，方便主人核对不是演的。
- 未连接时明示“当前连接：无；会话 ID：未取得”，禁用发送和停止，不展示假回答。
- 本批 panel 仅包含展示组件和未连接入口；第 4 批由DeepSeek Harness接入数据订阅、真实连接信息、发送与停止。
- 取消或超时后，宿主负责结束执行；迟到的完成事件不能把 stopped/timeout 覆盖成 done。

## 宿主产出伪代码（9 行；接口意图，不是已存在的 API）

```text
收到主人提问(question, member)，只选择该 member 的适配器和显式会话 ID
生成 m = {id:唯一ID, member, displayName:固定映射[member], text:"", status:"running", startedAt:本地时间(), endedAt:"", source:真实来源标签(), error:""}
发布(m)，更新连接说明中的真实成员与会话 ID
启动该成员一次执行(question, 显式会话ID, 超时, 停止信号)，不转发其他成员回答
收到执行证据时更新 m.source（会话 ID、耗时、token、缓存、退出码仅填真实已知值）
成功且尚未终结：m.status = "done"，m.text = 回答原文
失败/超时/主人停止且尚未终结：m.status = 对应状态，m.text = ""，m.error = 执行器或取消/超时控制器的错误原文
结束时设置 m.endedAt = 本地时间()，按同一 id 发布更新，锁定终态并忽略迟到结果
等待主人下一次点名，不自动调用下一位成员
```
