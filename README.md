# auto-resume-interrupt

> Claude Code 插件：当 API 错误 / 网关截断导致会话中断、任务尚未完成时，通过 **Stop hook** 自动让 Claude 原地续跑。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 解决什么问题

走低 SLA 第三方网关（自建 / 代理站点，`ANTHROPIC_BASE_URL` 指向非官方）时，会话常因 API 5xx、网关断开、响应中途截断而中断，但任务还没完成，Claude 却停在半截。

本插件在每轮结束时用 **Stop hook** 检测上一轮响应是否被截断；若是，则返回 `hookSpecificOutput.additionalContext` 喂一条"继续"指令，让 Claude 在**当前会话原地续跑**，而不是停在半截或丢失上下文。

## 工作原理

| 点 | 说明 |
|---|---|
| 扩展点 | Claude Code 没有"on API error" hook；`Stop` hook 在每轮结束时触发（含因 API 错误中断结束的轮次），可返回 `additionalContext` 让轮次继续（官方机制） |
| 检测口径 | **仅 API 错误截断**，不处理用户主动 Ctrl+C |
| 判定方式 | 用 `last_assistant_message` 文本完整性启发式，**不依赖 `stop_reason`**（部分代理网关 `output_tokens` 恒为 0、`stop_reason` 不可靠） |
| 截断信号 | 空响应 / 代码块未闭合 / 极短未收束 / 半句标点收尾 / 括号未配平 / 延续性收尾（如"首先我"） / 末尾截断特征词 |
| 防死循环 | ① `stop_hook_active` 守门（本轮已是续跑结果就不再喂）② Claude Code 内置 8 次 block 上限（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`）③ 正常结束语白名单避免误判完成 |

## 目录结构

```
auto-resume-interrupt/
├── .claude-plugin/
│   └── plugin.json              # 插件清单
├── .claude/
│   ├── settings.json            # Stop hook 配置（用 ${CLAUDE_PLUGIN_ROOT}）
│   └── scripts/
│       └── resume-check.js      # 核心判定脚本（Node，无外部依赖）
├── LICENSE
└── README.md
```

## 安装与启用

### 前置

- Claude Code（CLI / Desktop）
- Node.js（脚本运行时，无额外 npm 依赖）

### 方式 A：本地插件目录（推荐，可迁移）

1. Clone 本仓库到任意位置：

```bash
git clone https://github.com/buglyz/auto-resume-interrupt.git
```

2. 用 Claude Code 本地插件方式注册该目录（`/plugin` 指向本地路径，或按你当前版本的本地插件加载方式配置）。
3. 插件自带的 `.claude/settings.json` 已用 `${CLAUDE_PLUGIN_ROOT}`，无需改路径。
4. **重启 Claude Code 会话**使 hook 生效。
5. 输入 `/hooks`，在 `Stop` 事件下应看到指向 `resume-check.js` 的命令。

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
            "command": "node \"/绝对路径/到/auto-resume-interrupt/.claude/scripts/resume-check.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

> 把 `/绝对路径/到/auto-resume-interrupt` 换成你 clone 后的真实路径。  
> Windows 示例：`node "D:/path/to/auto-resume-interrupt/.claude/scripts/resume-check.js"`  
> 注意 hooks 结构必须是 `matcher` + `hooks` 数组，不能直接在 `Stop` 下放 `type`/`command`。

### 兜底：内置 env 变量（强烈建议同时开启）

在 `settings.json` 的 `env` 块加：

```json
"CLAUDE_CODE_RESUME_INTERRUPTED_TURN": "1"
```

它能免费处理最常见的"响应中途网络断开"场景（Claude Code 内置自动重跑该轮）。本插件覆盖它管不到的"轮次级截断 / 半句收束"场景。**两者一起开最稳。**

## 可调参数

编辑 `.claude/scripts/resume-check.js` 顶部 `CONFIG`：

| 参数 | 默认 | 说明 |
|---|---|---|
| `tooShortLength` | `10` | 短于此且未正常收束 → 视为刚开头就被掐断 |
| `truncateMarkers` | `connection` / `502` / … | 末尾窗口内出现的截断特征词（辅助信号） |
| `markerWindow` | `64` | 特征词匹配的末尾字符窗口 |

也可改脚本内 `CONTINUE_PROMPT` 自定义续跑提示语。

## 验证

```bash
S="./.claude/scripts/resume-check.js"

# 句中截断 → 应输出含 additionalContext 的续跑 JSON
echo '{"stop_hook_active":false,"last_assistant_message":"好的，我来实现这个功能，首先我"}' | node "$S"

# 正常完成 → 应输出 {}
echo '{"stop_hook_active":false,"last_assistant_message":"任务已完成。以上是本次改动，请验收。"}' | node "$S"

# stop_hook_active 守门 → 应输出 {}（防死循环）
echo '{"stop_hook_active":true,"last_assistant_message":"好的我来"}' | node "$S"

# 空响应 → 应续跑
echo '{"stop_hook_active":false,"last_assistant_message":""}' | node "$S"

# 用户主动停止 → 应输出 {}
echo '{"stop_hook_active":false,"stop_reason":"user_stop","last_assistant_message":"好的我来"}' | node "$S"
```

真实中断复现：在低 SLA 站点等一次响应中途被网关 5xx / 断流打断，观察 Claude 是否自动收到续跑 `additionalContext` 并继续输出。

## 排错

| 现象 | 排查 |
|---|---|
| hook 不生效 | 确认 `settings.json` 已保存并**重启了会话**；`/hooks` 查看已加载 hook |
| 误判正常回复为截断 | 调大 `tooShortLength`，或给 `endsWithNormalClosing` 加白名单词 |
| 漏判截断 | 给 `trailingContinuation` / `truncateMarkers` 补充特征；用真实中断文本手动喂脚本验证 |
| 一字未出就断流、hook 也没触发 | 可能 Claude Code 未产生 assistant message，此时应靠 env 兜底 `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` 接管 |
| 脚本异常 | 本脚本任何未捕获异常都放行（输出 `{}`），不会阻塞 Claude |

手动喂真实中断文本：

```bash
echo '{"stop_hook_active":false,"last_assistant_message":"这里粘真实中断文本"}' | node ./.claude/scripts/resume-check.js
```

- 输出续跑 JSON → 脚本判定正常，问题在 hook 未触发（看 `/hooks`）
- 输出 `{}` → 文本被判为"完整"，需要调 `CONFIG` / 启发式

## 设计取舍

- **不依赖 `stop_reason`**：部分代理网关（尤其 GLM 类）`output_tokens` 恒为 0、`stop_reason` 不规范，文本完整性启发式更贴合实情。
- **不 spawn 新 `--resume` 进程**：用 Stop hook 原地续跑，避免未文档化 flag 的兼容问题。
- **始终 exit 0 + stdout JSON**：不走 exit code 信号，避免和 Claude Code 的 exit-code 语义冲突。

## License

MIT
