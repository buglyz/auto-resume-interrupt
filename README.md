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

## 配置

### 配置文件（推荐方式）

创建 `~/.claude/auto-resume-interrupt.json`（Windows: `C:\Users\<你>\.claude\auto-resume-interrupt.json`）：

```json
{
  "tooShortLength": 5,
  "markerWindow": 120,
  "enableErrorKeyword": true,
  "enableRefusalPattern": true,
  "customRefusalPatterns": [],
  "customContinuePrompt": null,
  "debug": false
}
```

**配置优先级**：环境变量 `AUTO_RESUME_CONFIG_PATH` > `~/.claude/auto-resume-interrupt.json` > 内置默认值

参考 [config.example.json](config.example.json) 查看完整配置项。

### 配置项说明

| 参数 | 默认 | 说明 |
|---|---|---|
| `tooShortLength` | `5` | 短于此且非短确认白名单 → 视为刚开头就被掐断 |
| `markerWindow` | `120` | 特征词匹配的末尾字符窗口 |
| `enableErrorKeyword` | `true` | 开启 error 关键词检测（短文本全文检查，长文本检查最后两句） |
| `enableRefusalPattern` | `true` | 开启 API 拒绝模式检测（"can't help"、"start a new session" 等） |
| `customRefusalPatterns` | `[]` | 自定义拒绝模式（追加到内置列表） |
| `customContinuePrompt` | `null` | 自定义续跑提示语（null 则使用内置多语言提示） |
| `truncateMarkers` | 50+ 项 | 末尾窗口内截断特征词（网络错误/API错误/超时/限流等） |
| `debug` | `false` | 开启调试日志（也可用环境变量 `AUTO_RESUME_DEBUG=1`） |

### 环境变量

| 变量 | 说明 |
|---|---|
| `AUTO_RESUME_CONFIG_PATH` | 指定配置文件路径 |
| `AUTO_RESUME_DEBUG` | 设为 `1` 开启调试日志 |
| `AUTO_RESUME_DEBUG_LOG` | 自定义调试日志路径（默认 `~/.claude/auto-resume-interrupt.debug.log`） |
| `AUTO_RESUME_LANG` | 续跑提示语言（`zh` / `en`，默认 `zh`） |

### 检测能力（v0.3.1）

- **API 拒绝响应**：检测 "can't help"、"start a new session"、"无法帮助" 等，自动续跑
- **error 关键词强化**：短文本（< 100 字符）全文检查，包含 error/exception/failed/异常/错误/失败 等关键词时强制续跑
- **延续性收尾优化**：短句（< 20 字符）含延续词（首先我/然后我/接下来我等）时判定为截断，降低误判
- **null 响应处理**：API 返回 null 时视为截断
- **严格括号配平**：左括号未闭合或右括号多余都视为截断
- **完整测试套件**：40 个测试用例覆盖各类场景（基础截断/API拒绝/error关键词/延续性/误判防护等）

## 验证

### 快速测试

```bash
S="./scripts/resume-check.js"

# 句中截断 → 应输出 decision:block
echo '{"stop_hook_active":false,"last_assistant_message":"好的，我来实现这个功能，首先我"}' | node "$S"

# 正常完成 → 应输出 
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
echo '{"stop_hook_active":false,"last_assistant_message":"API error"}' | node "$S"

# 逗号 + 延续词 → 应续跑
echo '{"stop_hook_active":false,"last_assistant_message":"好的，接下来我"}' | node "$S"

# 用户主动停止 → 应输出 {}
echo '{"stop_hook_active":false,"stop_reason":"user_stop","last_assistant_message":"好的我来"}' | node "$S"

# 短确认不应误判 → 应输出 {}
echo '{"stop_hook_active":false,"last_assistant_message":"好的"}' | node "$S"
echo '{"stop_hook_active":false,"last_assistant_message":"可以了"}' | node "$S"

# 完整短句不误判 → 应输出 {}
echo '{"stop_hook_active":false,"last_assistant_message":"可以，首先我确认一下需求。"}' | node "$S"

# 技术讨论不误判（完整句 + 句号）→ 应输出 {}
echo '{"stop_hook_active":false,"last_assistant_message":"这个问题是由于 connection error 导致的，已经修复。"}' | node "$S"
```

### 完整测试套件

运行测试脚本：

```bash
bash test/test.sh
```

### 真实场景验证

在低 SLA 站点等一次响应中途被网关 5xx / 断流打断，观察 Claude 是否自动收到续跑指令并继续输出。

## 排错

| 现象 | 排查 |
|---|---|
| hook 不生效 | 确认已保存配置并**重启会话**；`/hooks` 查看已加载 hook |
| 作为插件装了没看到 hook | 确认存在 `hooks/hooks.json`，且 `plugin.json` 的 `hooks` 字段指向它 |
| 误判正常回复为截断 | 开启 `AUTO_RESUME_DEBUG=1`，查看 `~/.claude/auto-resume-interrupt.debug.log` 判定原因；可能触发了 error 关键词或延续性收尾规则 |
| 漏判截断 | 用真实中断文本手动喂脚本测试；可降低 `tooShortLength` 或补充 `truncateMarkers` |
| 一字未出就断流、hook 也没触发 | 可能未产生 assistant message，靠 `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` 兜底 |
| 脚本异常 | 任何未捕获异常都放行（输出 `{}`），不会阻塞 Claude；查看调试日志 |
| Windows 下 command 失败 | 确认 `node` 在 PATH；路径用正斜杠或正确转义引号 |

### 调试日志

开启调试模式：

```bash
# 方式 1：环境变量（临时）
AUTO_RESUME_DEBUG=1 claude

# 方式 2：自定义日志路径
AUTO_RESUME_DEBUG=1 AUTO_RESUME_DEBUG_LOG=/path/to/debug.log claude
```

日志格式（每行一个 JSON）：

```json
{
  “ts”: “2026-08-12T10:30:45.123Z”,
  “action”: “block”,
  “reason”: “interrupted”,
  “stop_reason”: “end_turn”,
  “hook_event_name”: “Stop”,
  “msgLen”: 15,
  “msgPreview”: “好的，我来实现这个功能，首先我”,
  “payloadKeys”: [“session_id”, “transcript_path”, “stop_hook_active”, “last_assistant_message”]
}
```

### 手动测试真实中断文本

```bash
# 把真实中断的最后一条响应粘贴到这里测试
echo '{“stop_hook_active”:false,”last_assistant_message”:”这里粘真实中断文本”}' | node ./scripts/resume-check.js
```

- 输出含 `”decision”:”block”` → 脚本判定正常，问题在 hook 未触发
- 输出 `{}` → 文本被判为”完整”，需要调整配置或启发式规则
- 查看 `detectedBy` 字段了解触发原因

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
  - **缓解**：扩展 `isShortAck` 白名单；`tooShortLength` 已降至 5

### 2. 激进 error 检测的权衡
- **策略**：短文本（< 100 字符）全文检查，长文本检查最后两句
- **风险**：正在写错误处理代码时（如 "throw new Error(...)"）若被网络截断在此处，会误判
- **防护**：
  - `looksComplete()` 前置：已正常收束的技术讨论不触发
  - Claude Code 内置 8 次 block 上限兜底
  - `stop_hook_active` 守门防死循环
  - 可通过 `enableErrorKeyword: false` 关闭

### 3. 依赖文本启发式
- 部分代理网关 `stop_reason` / `usage.output_tokens` 不可靠，仅能通过文本推断
- 极端场景（如响应恰好被截断在句号前一个字符）可能漏判

### 4. 防护措施
- ✅ `stop_hook_active` 守门：hook 续跑的响应不会再次触发 hook
- ✅ Claude Code 内置 8 次 block 上限
- ✅ 短确认白名单（"好的"/"可以了"/"没问题"等）
- ✅ 正常收束检测（句号/已完成/请验收等）
- ✅ 延续性上下文检查（必须同时满足：延续词 + 无句号 + (很短 || 逗号结尾)）
- ✅ 决策路径日志：`AUTO_RESUME_DEBUG=1` 查看每个规则的判定结果
- ✅ 配置开关：可关闭 `enableErrorKeyword` / `enableRefusalPattern`

### 5. 调整建议
遇到误续跑时：
1. 开启调试日志 `AUTO_RESUME_DEBUG=1`
2. 查看 `~/.claude/auto-resume-interrupt.debug.log` 中的 `decisions` 和 `detectedBy` 字段
3. 根据触发规则调整对应配置项：
   - `refusal_pattern` 触发 → 调整 `customRefusalPatterns` 或关闭 `enableRefusalPattern`
   - `error_keyword` 触发 → 关闭 `enableErrorKeyword` 或调整上下文
   - `trailing_continuation` 触发 → 增加 `tooShortLength`
   - `truncate_marker` 触发 → 调整 `truncateMarkers` 列表
4. 提 issue 附上真实截断文本和调试日志

## 更新日志

### v0.3.1 (2026-08-12)

**增强**
- 🚀 **error 关键词检测强化**：短文本（< 100 字符）全文检查 error/exception/failed/timeout/异常/错误/失败 等关键词，强制续跑
- 🎯 **延续性收尾优化**：短句（< 20 字符）阈值从 15 提升到 20，减少"好的，首先我"类场景的误判
- ✅ **完整测试套件**：新增 40 个自动化测试用例，覆盖基础截断/API拒绝/error关键词/延续性/守门机制/误判防护等场景
- 📝 **配置示例**：新增 `.claude-plugin/config.example.json` 作为配置参考

**修复**
- 🐛 修复"好的，我来实现这个功能，首先我"（15字符）未被判定为截断的问题

**文档**
- 📖 README 补充完整测试验证说明
- 📖 补充配置项说明和环境变量参考

### v0.3.0 (2026-08-11)

**核心功能**
- 🎉 初始版本发布
- 🔄 Stop hook 自动续跑机制
- 🛡️ API 拒绝响应检测（can't help / start a new session）
- 🔍 多维度截断检测（空响应/代码块/括号/延续性收尾/截断特征词）
- 🚦 三重防护（stop_hook_active 守门 / 8次上限 / 短确认白名单）
- 🐛 调试日志支持（AUTO_RESUME_DEBUG=1）

## License

MIT
