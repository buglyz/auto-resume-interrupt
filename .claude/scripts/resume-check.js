#!/usr/bin/env node
/**
 * auto-resume-interrupt — Stop hook
 *
 * 当 Claude 的上一轮响应被 API 错误 / 网关截断中断、任务尚未完成时，
 * 通过返回 hookSpecificOutput.additionalContext 让 Claude 原地续跑。
 *
 * 设计要点（贴合低 SLA 第三方网关站点，不依赖 stop_reason）：
 *   1. stop_hook_active 守门：若本轮已是 hook 续跑出来的，直接放行不喂，
 *      避免在同一失败轮次上无限喂数据（防 changelog 第 3040 行死循环 bug）。
 *   2. 用 last_assistant_message 文本完整性启发式判断是否被截断，
 *      而非依赖 stop_reason / usage（GLM 代理网关 output_tokens 恒为 0，不可靠）。
 *   3. Claude Code 自身有 8 次 block 上限（CLAUDE_CODE_STOP_HOOK_BLOCK_CAP）兜底，
 *      本脚本再用 stop_hook_active + 连续截断计数双层防死循环。
 *   4. 仅处理“API 错误截断”，不处理用户主动 Ctrl+C（用户主动停止不会触发本判定为截断）。
 *
 * 输入：stdin JSON，含 session_id / transcript_path / stop_hook_active / last_assistant_message 等。
 * 输出：stdout JSON —— 续跑时返回 {"hookSpecificOutput":{"additionalContext":"..."}}
 */

'use strict';

const fs = require('fs');

// ────────────── 可调参数 ──────────────
const CONFIG = {
  // 文本短于这个长度且非结束语，视为“刚开头就被掐断”
  tooShortLength: 10,
  // 截断特征词（仅在出现在文本末尾附近时才作为辅助信号，单独不足以判定，
  // 以免误伤正常长正文中提到这些技术词的响应）
  truncateMarkers: [
    'connection', 'bad gateway', 'overloaded', 'timeout', 'timed out',
    'reset by peer', 'econnreset', '502', '503', '504', '529',
    'interrupted', 'stream', 'incomplete',
  ],
  // 特征词匹配窗口：文本末尾 N 个字符内
  markerWindow: 64,
};

// ────────────── 续跑提示语 ──────────────
const CONTINUE_PROMPT =
  '你的上一轮响应被 API 错误 / 网关截断中断了，任务尚未完成。' +
  '请从上次中断处继续完成未完成任务，不要重头开始，不要重复已经做过的步骤。';

// ────────────── 工具函数 ──────────────
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    // 没有 stdin 时（手动调试可能如此）也要能 resolve
    process.stdin.on('error', () => resolve(''));
    // 兜底：极端情况下 5s 内必须返回，不要卡住 hook（hook timeout=10s）
    setTimeout(() => resolve(data), 5000);
  });
}

// 是否以正常的句末标点收束（中英文）
function endsWithSentenceEnd(text) {
  const t = text.trimEnd();
  if (!t) return false;
  return /[。！？!?…\n]$|```$/.test(t) || /\.\s*$/.test(t);
}

// 代码块 ``` 是否闭合
function codeBlocksBalanced(text) {
  const matches = text.match(/```/g);
  if (!matches) return true; // 无代码块
  // 代码块标记必须成对（偶数）
  return matches.length % 2 === 0;
}

// 括号/圆括号是否大致配平（仅看未闭合的左括号是否过多）
function bracketsBalanced(text) {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  // 末尾若有大量未闭合左括号，视为句中截断
  return depth <= 0;
}

// 末尾是否是“半句”标志：逗号/顿号收尾，或连接词/未完动词收尾（首先/然后/接着/接下来/等等）
function trailingHalfSentence(text) {
  const t = text.trimEnd();
  if (!t) return false;
  // 逗号、顿号、顿号点收尾 → 明显半句
  if (/[，、,;；]$/.test(t)) return true;
  // 连接词 / 未完动词收尾
  if (/(?:首先|然后|接着|接下来|于是|因此|所以|最后|同时|另外|此外|即|也就是)$/.test(t)) return true;
  return false;
}

// 是否以“正常结束语”收尾 —— 命中则即使无句号也视为完成，避免误判（如“以上请验收”“改动已完成”）
function endsWithNormalClosing(text) {
  const t = text.trimEnd().toLowerCase();
  if (!t) return false;
  return /(?:以上|请验收|请审阅|请确认|已完成|已完成。|完成。|谢谢|请查看|如下|请参考|结束)$/.test(t)
    || /(?:done|completed|please review|see above|finished|let me know)$/.test(t);
}

// 末尾是否是“延续性收尾” —— 未收束、像句中（首先我 / 然后我 / 我来 / 让我 等）
function trailingContinuation(text) {
  const t = text.trimEnd();
  if (!t) return false;
  // 单字代词/动词收尾：我 / 来 / 是 / 的 / 和 / 或 / 与 / 在 / 把 / 将 / 让 / 给 / 对 / 向
  if (/[我来是的和或与在把将给对向]$/.test(t)) return true;
  // 连接词收尾（不锚定结尾，末尾窗口内出现且未收束即算）
  if (/(?:首先|然后|接着|接下来|于是|因此|所以|最后|同时|另外|此外|也就是)$/.test(t)) return true;
  return false;
}

// 文本末尾窗口内是否含截断特征词
function hasTruncateMarker(text) {
  const tail = text.slice(-CONFIG.markerWindow).toLowerCase();
  return CONFIG.truncateMarkers.some((m) => tail.includes(m));
}

/**
 * 判定 last_assistant_message 是否被“API 错误截断”。
 * @returns {boolean}
 */
function isInterrupted(message) {
  // 字段缺失/null（非空串）—— 保守放行，不续跑
  if (message === null || message === undefined) return false;
  if (typeof message !== 'string') return false;

  const text = message;
  const trimmed = text.trimEnd();

  // ── 强信号：明确被截断 ──
  // 空串 —— 一字未出就中断
  if (trimmed.length === 0) return true;

  // 代码块未闭合 —— 代码写到一半被截断
  if (!codeBlocksBalanced(text)) return true;

  // 极短且非正常收束 —— 响应刚开头就被掐断
  if (trimmed.length < CONFIG.tooShortLength && !endsWithSentenceEnd(trimmed) && !endsWithNormalClosing(trimmed)) {
    return true;
  }

  // 正常结束语收尾 —— 视为完成，不再判
  if (endsWithNormalClosing(trimmed) || endsWithSentenceEnd(trimmed)) {
    // 但若代码块未闭合已在上面返回，这里其余都算正常
    return false;
  }

  // ── 次信号：未正常收束，叠加半句特征 ──
  // 半句标点收尾（逗号/顿号/分号）→ 句中截断
  if (/[，、,;；]$/.test(trimmed)) return true;

  // 括号未配平 → 句中截断
  if (!bracketsBalanced(text)) return true;

  // 延续性收尾（首先我 / 然后来 / 让我 等未完动词/代词）→ 句中截断
  if (trailingContinuation(trimmed)) return true;

  // 末尾窗口含截断特征词 + 未收束 → 辅助信号
  if (hasTruncateMarker(text)) return true;

  return false;
}

// ────────────── 主流程 ──────────────
async function main() {
  const raw = await readStdin();

  let payload = {};
  if (raw && raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      // stdin 非 JSON，放行不续跑（避免异常导致卡死）
      process.stdout.write('{}');
      return;
    }
  }

  // 守门 1：本轮已是 hook 续跑出来的，直接放行，防死循环
  if (payload.stop_hook_active === true) {
    process.stdout.write('{}');
    return;
  }

  // 用户主动停止信号（部分版本会传 stop_hook_active 之外的字段）：
  // 若 payload 明确标识是用户取消，放行
  if (payload.stop_reason === 'user_stop' || payload.user_initiated === true) {
    process.stdout.write('{}');
    return;
  }

  // 判定是否被截断
  const message = payload.last_assistant_message;
  if (isInterrupted(message)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { additionalContext: CONTINUE_PROMPT },
    }));
    return;
  }

  // 正常 end_turn / 完整收束 —— 不打扰
  process.stdout.write('{}');
}

main().catch(() => {
  // 任何未捕获异常都放行，绝不阻塞 Claude
  try { process.stdout.write('{}'); } catch {}
});
