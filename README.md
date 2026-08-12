# auto-resume-interrupt

> Claude Code 插件：当 API 错误 / 网关截断导致会话中断、任务尚未完成时，通过 **Stop hook** 自动让 Claude 原地续跑。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 解决什么问题

走低 SLA 第三方网关（自建 / 代理站点，`ANTHROPIC_BASE_URL` 指向非官方）时，会话常因 API 5xx、网关断开、响应中途截断而中断，但任务还没完成，Claude 却停在半截。

本插件在每轮结束时用 **Stop hook** 检测上一轮响应是否被截断；若是，则返回 `decision: "block"` + `reason`（并附带 `additionalContext`）喂一条“继续”指令，让 Claude 在**当前会话原地续跑**。

## 工作原理

| 点 | 说明 |
|---|---|
| 扩展点 | Claude Code 没有独立的 “on API error” hook；`Stop` 在每轮结束时触发（含因 API 错误中断结束的轮次） |
| 续跑输出 | 主路径 `{“decision”:”block”,”reason”:”...”}`；补充 `hookSpecificOutput.additionalContext`（官方支持 Stop/SubagentStop 用其续跑且不标 hook 错误） |
| 检测口径 | **仅 API 错误截断**；若 payload 带明确用户停止信号则放行 |
| 判定方式 | 用 `last_assistant_message` 文本完整性启发式，**不依赖 `stop_reason` / usage**（部分代理网关不可靠） |
| 截断信号 | null/空响应 / API拒绝响应 / error关键词 / 代码块未闭合 / 极短未收束 / 半句标点 / 括号未配平 / 延续性收尾 / 末尾截断特征词 |
| 防死循环 | ① `stop_hook_active` 守门 ② Claude Code 内置 8 次 block 上限（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`） ③ 正常收束与短确认白名单降低误判 |

## 目录结构

```
auto-resume-interrupt/
├── .claude-plugin/
│   └── plugin.json           # 插件清单（hooks 指向 hooks/hooks.json）
├── hooks/
│   └── hooks.json            # 插件 hooks 标准落点
├── scripts/
│   └── resume-check.js       # 核心判定脚本（Node，无外部依赖）
├── LICENSE
└── README.md
```

## 安装与启用

### 前置

- Claude Code（CLI / Desktop）
- Node.js（脚本运行时，无额外 npm 依赖）

### 方式 A：本地插件目录（推荐）

1. Clone 本仓库：

```bash
git clone https://github.com/buglyz/auto-resume-interrupt.git
```

2. 在 Claude Code 中用本地插件方式加载该目录（`/plugin` → 本地路径，或按当前版本的 local plugin 流程）。
3. 插件通过 `hooks/hooks.json` + `${CLAUDE_PLUGIN_ROOT}` 注册 Stop hook，**无需改路径**。
4. **重启会话**使 hook 生效。
5. 输入 `/hooks`，在 `Stop` 事件下应看到指向 `scripts/resume-check.js` 的命令。

### 方式 B：直接写用户级 settings（最稳，免插件注册）

把 hook 配置直接加进用户级 `~/.claude/settings.json`（Windows 一般是 `C:\Users\<你>\.claude\settings.json`）：

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/绝对路径/到/auto-resume-interrupt/scripts/resume-check.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

> 把路径换成 clone 后的真实路径。  
> Windows 示例：`node "D:/path/to/auto-resume-interrupt/scripts/resume-check.js"`  
> 注意 hooks 结构必须是 `matcher` + `hooks` 数组。

### 兜底：内置 env 变量（强烈建议同时开启）

在 `settings.json` 的 `env` 块加：

```json
"CLAUDE_CODE_RESUME_INTERRUPTED_TURN": "1"
```

它能处理最常见的“响应中途网络断开”场景（Claude Code 内置自动重跑该轮）。本插件覆盖它管不到的“轮次级截断 / 半句收束”场景。**两者一起开最稳。**

## 可调参数

编辑 `scripts/resume-check.js` 顶部 `CONFIG`：

| 参数 | 默认 | 说明 |
|---|---|---|
| `tooShortLength` | `5` | 短于此且非短确认白名单 → 视为刚开头就被掐断（已降至 5 以覆盖更多中文短句） |
| `truncateMarkers` | 50+ 项 | 末尾窗口内截断特征词（网络错误/API错误/超时/限流等），辅助信号 |
| `markerWindow` | `120` | 特征词匹配的末尾字符窗口 |
| `debug` | `false` | 设 `AUTO_RESUME_DEBUG=1` 开启调试日志（写入 `~/.claude/auto-resume-interrupt.debug.log`） |

**新增检测能力**（v0.3.0+）：
- **API 拒绝响应**：检测 "can't help"、"start a new session" 等拒绝类响应，自动续跑
- **error 关键词强制续跑**：最后两句话范围内包含 error/exception/failed/timeout/错误/异常/失败 等关键词，激进续跑
- **null 响应处理**：API 返回 null 时视为截断，触发续跑
- **严格括号配平**：右括号多余也视为截断（如 JSON 被截断剩 `}}`）

也可改脚本内 `CONTINUE_PROMPT` 自定义续跑提示语。

## 验证

```bash
S="./scripts/resume-check.js"

# 句中截断 → 应输出 decision:block
echo '{"stop_hook_active":false,"last_assistant_message":"好的，我来实现这个功能，首先我"}' | node "$S"

# 正常完成 → 应输出 {}
echo '{"stop_hook_active":false,"last_assistant_message":"任务已完成。以上是本次改动，请验收。"}' | node "$S"

# stop_hook_active 守门 → 应输出 {}
echo '{"stop_hook_active":true,"last_assistant_message":"好的我来"}' | node "$S"

# 空响应 → 应续跑
echo '{"stop_hook_active":false,"last_assistant_message":""}' | node "$S"

# null 响应 → 应续跑
echo '{"stop_hook_active":false,"last_assistant_message":null}' | node "$S"

# API 拒绝响应 → 应续跑
echo '{"stop_hook_active":false,"last_assistant_message":"Fable 5 can'\''t help with this"}' | node "$S"

# error 关键词 → 应续跑
echo '{"stop_hook_active":false,"last_assistant_message":"Connection error"}' | node "$S"
echo '{"stop_hook_active":false,"last_assistant_message":"API rate limit exceeded"}' | node "$S"

# 用户主动停止 → 应输出 {}
echo '{"stop_hook_active":false,"stop_reason":"user_stop","last_assistant_message":"好的我来"}' | node "$S"

# 短确认不应误判
echo '{"stop_hook_active":false,"last_assistant_message":"好的"}' | node "$S"
echo '{"stop_hook_active":false,"last_assistant_message":"可以了"}' | node "$S"

# 技术讨论不误判（完整句 + 句号）
echo '{"stop_hook_active":false,"last_assistant_message":"这个问题是由于 connection error 导致的，已经修复。"}' | node "$S"
```

真实中断复现：在低 SLA 站点等一次响应中途被网关 5xx / 断流打断，观察 Claude 是否自动收到续跑指令并继续输出。

## 排错

| 现象 | 排查 |
|---|---|
| hook 不生效 | 确认已保存配置并**重启会话**；`/hooks` 查看已加载 hook |
| 作为插件装了没看到 hook | 确认存在 `hooks/hooks.json`，且 `plugin.json` 的 `hooks` 字段指向它 |
| 误判正常回复为截断 | 调大 `tooShortLength`，或给 `endsWithNormalClosing` / 短确认白名单加词 |
| 漏判截断 | 给 `trailingContinuation` / `truncateMarkers` 补充特征；用真实中断文本手动喂脚本 |
| 一字未出就断流、hook 也没触发 | 可能未产生 assistant message，靠 `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` 兜底 |
| 脚本异常 | 任何未捕获异常都放行（输出 `{}`），不会阻塞 Claude |
| Windows 下 command 失败 | 确认 `node` 在 PATH；路径用正斜杠或正确转义引号 |

手动喂真实中断文本：

```bash
echo '{"stop_hook_active":false,"last_assistant_message":"这里粘真实中断文本"}' | node ./scripts/resume-check.js
```

- 输出含 `decision":"block"` → 脚本判定正常，问题在 hook 未触发
- 输出 `{}` → 文本被判为“完整”，需要调 `CONFIG` / 启发式

## 设计取舍

- **不依赖 `stop_reason`**：部分代理网关（尤其 GLM 类）字段不规范，文本启发式更贴合实情。
- **`decision:block` 为主，`additionalContext` 为辅**：对齐 Stop hook 官方续跑通道。
- **不 spawn 新 `--resume` 进程**：用 Stop hook 原地续跑，避免会话分裂与未文档 flag。
- **始终 exit 0 + stdout JSON**：不走 exit code 信号，避免和 Claude Code 的 exit-code 语义冲突。
- **插件 hooks 落在 `hooks/hooks.json`**：符合 `claude plugin validate` 检查约定，而不是只写项目式 `.claude/settings.json`。

## 已知局限

### 1. 误续跑场景
- **技术讨论**：讨论网络错误时如"调试 connection reset 问题"，若未以句号收尾可能误触发
  - **缓解**：`looksComplete()` 优先判断；完整句 + 句号会放行
- **中文短句**：省略句号的短句（如"好"、"行"）已加白名单，但新词仍可能误判
  - **缓解**：扩展 `isShortAck` 白名单；已降低 `tooShortLength` 到 5

### 2. 激进 error 检测的权衡
- **策略**：最后两句话范围内包含 error/exception/failed 等关键词即触发续跑
- **风险**：正在写错误处理代码时（如 "throw new Error(...)"）若被网络截断在此处，会误判
- **防护**：
  - `looksComplete()` 前置：已正常收束的技术讨论不触发
  - Claude Code 内置 8 次 block 上限兜底
  - `stop_hook_active` 守门防死循环

### 3. 依赖文本启发式
- 部分代理网关 `stop_reason` / `usage.output_tokens` 不可靠，仅能通过文本推断
- 极端场景（如响应恰好被截断在句号前一个字符）可能漏判

### 4. 防护措施
- ✅ `stop_hook_active` 守门：hook 续跑的响应不会再次触发 hook
- ✅ Claude Code 内置 8 次 block 上限
- ✅ 短确认白名单（"好的"/"可以了"/"没问题"等）
- ✅ 正常收束检测（句号/已完成/请验收等）
- ✅ `AUTO_RESUME_DEBUG=1` 调试日志：排查误判时查看 `~/.claude/auto-resume-interrupt.debug.log`

### 5. 调整建议
遇到误续跑时：
1. 开启调试日志 `AUTO_RESUME_DEBUG=1`
2. 查看日志中的 `msgPreview` 和判定原因
3. 调整 `CONFIG` 参数或启发式规则
4. 提 issue 附上真实截断文本

## License

MIT
