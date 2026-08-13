#!/usr/bin/env node
/**
 * auto-resume-interrupt — Stop hook
 *
 * 当 Claude 的上一轮响应被 API 错误 / 网关截断中断、任务尚未完成时，
 * 通过返回 decision:block + reason 让 Claude 原地续跑。
 *
 * 设计要点（贴合低 SLA 第三方网关，不依赖 stop_reason）：
 *   1. stop_hook_active 守门：本轮已是 hook 续跑结果则直接放行，防死循环。
 *   2. 用 last_assistant_message 文本完整性启发式判断是否被截断
 *      （部分代理网关 output_tokens 恒为 0、stop_reason 不可靠）。
 *   3. Claude Code 内置 8 次 block 上限（CLAUDE_CODE_STOP_HOOK_BLOCK_CAP）兜底。
 *   4. 仅处理 API 错误截断；用户主动停止若有明确信号则放行。
 *   5. 默认保守：无明确截断信号则放行，优先避免误续跑。
 *
 * 输入：stdin JSON（session_id / transcript_path / stop_hook_active / last_assistant_message 等）
 * 输出：stdout JSON
 *   - 续跑：{"decision":"block","reason":"...","hookSpecificOutput":{"additionalContext":"..."}}
 *   - 放行：{}
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ────────────── 默认配置 ──────────────
const DEFAULT_CONFIG = {
  // 仅当文本短于此值，且不在短确认白名单时，才因”过短”判截断
  tooShortLength: 5,
  // 截断特征词：仅作辅助信号（末尾窗口命中 + 未正常收束）
  truncateMarkers: [
    // 网络层错误
    'connection reset', 'bad gateway', 'overloaded', 'timed out',
    'reset by peer', 'econnreset', 'gateway timeout',
    // HTTP 状态码（带前导空格，避免误伤正文中的纯数字）
    'error 400', 'error 401', 'error 403', 'error 404', 'error 408', 'error 429',
    'error 500', 'error 502', 'error 503', 'error 504', 'error 520', 'error 521', 'error 522',
    'error 523', 'error 524', 'error 529',
    ' 400', ' 401', ' 403', ' 404', ' 408', ' 429',
    ' 500', ' 502', ' 503', ' 504', ' 520', ' 521', ' 522', ' 523', ' 524', ' 529',
    // API/Gateway 错误
    'api error', 'rate limit', 'quota exceeded', 'too many requests',
    'service unavailable', 'upstream error', 'proxy error',
    'backend error', 'internal server error',
    'bad_response_status_code', 'do_request_failed', 'new_api_error',
    // 超时类
    'request timeout', 'read timeout', 'write timeout', 'connection timeout',
    'deadline exceeded', 'context deadline exceeded',
    // 连接类
    'connection refused', 'connection closed', 'connection aborted',
    'broken pipe', 'network unreachable', 'host unreachable',
    // 认证/限流
    'unauthorized', 'forbidden', 'access denied', 'authentication failed',
    'too many retries', 'retry limit exceeded',
    // 第三方网关中文特征（new-api / one-api 类代理）
    '上游问题', '上游接口不存在', '渠道出错', '渠道错误', '请求失败',
  ],
  markerWindow: 120,
  // 功能开关
  enableErrorKeyword: true,
  enableRefusalPattern: true,
  // 自定义拒绝模式（追加到内置列表）
  customRefusalPatterns: [],
  // 自定义续跑提示（null 则使用内置多语言提示）
  customContinuePrompt: null,
  // 调试开关
  debug: false,
};

// 加载配置：环境变量 > 配置文件 > 默认值
function loadConfig() {
  const configPath = process.env.AUTO_RESUME_CONFIG_PATH
    || path.join(os.homedir(), '.claude', 'auto-resume-interrupt.json');

  try {
    if (fs.existsSync(configPath)) {
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const merged = { ...DEFAULT_CONFIG, ...userConfig };
      debugLog({ action: 'config_loaded', path: configPath });
      return merged;
    }
  } catch (err) {
    debugLog({ warning: 'config_load_failed', path: configPath, error: err.message });
  }

  return DEFAULT_CONFIG;
}

// 全局配置（延迟加载，避免循环依赖）
let CONFIG = null;
function getConfig() {
  if (!CONFIG) {
    CONFIG = loadConfig();
    // 环境变量覆盖
    if (process.env.AUTO_RESUME_DEBUG === '1' || process.env.AUTO_RESUME_DEBUG === 'true') {
      CONFIG.debug = true;
    }
  }
  return CONFIG;
}

function debugLogPath() {
  if (process.env.AUTO_RESUME_DEBUG_LOG) return process.env.AUTO_RESUME_DEBUG_LOG;
  return path.join(os.homedir(), '.claude', 'auto-resume-interrupt.debug.log');
}

function debugLog(entry) {
  const cfg = getConfig();
  if (!cfg.debug) return;
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + '\n';
    fs.appendFileSync(debugLogPath(), line, 'utf8');
  } catch {
    // 调试失败绝不影响主流程
  }
}

// ────────────── 续跑提示语 ──────────────
const CONTINUE_PROMPTS = {
  zh: '你的上一轮响应被 API 错误 / 网关截断中断了，任务尚未完成。请从上次中断处继续完成未完成任务，不要重头开始，不要重复已经做过的步骤。',
  en: 'Your previous response was interrupted by an API error or gateway timeout, and the task is not yet complete. Please continue from where you left off without restarting or repeating completed steps.',
};

function getContinuePrompt() {
  const cfg = getConfig();
  if (cfg.customContinuePrompt) return cfg.customContinuePrompt;
  const lang = process.env.AUTO_RESUME_LANG || 'zh';
  return CONTINUE_PROMPTS[lang] || CONTINUE_PROMPTS.zh;
}

// ────────────── 工具函数 ──────────────
async function readStdin() {
  // for-await 在管道关闭时立即结束；TTY 手动调试则得到空串
  try {
    if (process.stdin.isTTY) return '';
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    }
    return chunks.join('');
  } catch {
    return '';
  }
}

function endsWithSentenceEnd(text) {
  const t = text.trimEnd();
  if (!t) return false;
  return /[。！？!?…]$/.test(t) || /```\s*$/.test(t) || /\.\s*$/.test(t);
}

/**
 * 提取围栏代码块（行首三反引号或三波浪号），返回代码块内容和围栏外文本。
 * 只识别真正的围栏代码块，忽略行内代码（单反引号），避免误判。
 */
function extractFencedBlocks(text) {
  const blocks = [];
  const outsideParts = [];
  const lines = text.split('\n');
  let inBlock = false;
  let fenceChar = null;
  let blockBuf = [];

  for (const line of lines) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch && !inBlock) {
      inBlock = true;
      fenceChar = fenceMatch[1][0];
      blockBuf = [];
      continue;
    }
    if (inBlock && fenceMatch && fenceMatch[1][0] === fenceChar) {
      inBlock = false;
      blocks.push(blockBuf.join('\n'));
      fenceChar = null;
      blockBuf = [];
      continue;
    }
    if (inBlock) {
      blockBuf.push(line);
    } else {
      outsideParts.push(line);
    }
  }

  if (inBlock) {
    blocks.push(blockBuf.join('\n'));
  }

  return {
    blocks,
    outsideText: outsideParts.join('\n'),
    hasUnclosed: inBlock,
  };
}

function codeBlocksBalanced(text) {
  const { hasUnclosed } = extractFencedBlocks(text);
  return !hasUnclosed;
}

function bracketsBalanced(text) {
  // 只统计围栏代码块之外的括号；代码块内的括号是代码内容，不应参与配平
  const { outsideText } = extractFencedBlocks(text);
  let round = 0;
  let square = 0;
  let curly = 0;
  for (const ch of outsideText) {
    if (ch === '(') round++;
    else if (ch === ')') round--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
    else if (ch === '{') curly++;
    else if (ch === '}') curly--;
  }
  // 花括号严格配平（{ 多于 } 是真实截断信号，如 function foo() { 被截断）；
  // 圆括号/方括号宽松（右多余在技术回复常见，如 JSON 片段）
  return curly === 0 && round >= 0 && square >= 0;
}

function endsWithNormalClosing(text) {
  const t = text.trimEnd().toLowerCase();
  if (!t) return false;
  // 明确的收束词组（完整短语，任意长度）
  const closingPhrases = /(?:以上|请验收|请审阅|请确认|已完成|完成|谢谢|请查看|如下|请参考|结束|没问题|可以了|好了|搞定|done|completed|please review|see above|finished|let me know|all set|looks good)$/i;
  if (closingPhrases.test(t)) return true;
  // 单字收束词需配合短长度（避免"我需要确认"被误判为完整）
  if (t.length < 15 && /(?:确认|验收|审阅|参考|查看)$/.test(t)) return true;
  return false;
}

function isShortAck(text) {
  const t = text.trim();
  return /^(好的|可以|可以了|行|嗯|没问题|没问题了|收到|收到了|明白|明白了|了解|继续|开始|ok|okay|yes|no|是的|不是|done|sure)[.!！。]?$/i.test(t);
}

function trailingHalfPunctuation(text) {
  const t = text.trimEnd();
  if (!t) return false;
  return /[，、,;；：:]$/.test(t);
}

/**
 * 延续性收尾：像话没说完。
 * 统一长短句检查逻辑，消除 30 字符边界跳变。
 * 只要无句号结尾且含延续词，即视为截断。
 */
function trailingContinuation(text) {
  const t = text.trimEnd();
  if (!t) return false;

  const noSentenceEnd = !endsWithSentenceEnd(t);

  // 中英文延续词，所有长度统一检查（无句号结尾时）
  const hasContinuationWord = /(?:首先我|然后我|接着我|接下来我|于是我|因此我|所以我|让我|我来|我将|我会|我先|现在我|下面我|接下来|首先|然后|接着)$/.test(t);
  if (hasContinuationWord && noSentenceEnd) {
    return true;
  }

  const hasEnglishContinuation = /\b(?:by|to|and|with|for|the|a|an|of|in|on|from|into|via|using|implement|create|update|fix)$/i.test(t);
  if (hasEnglishContinuation && noSentenceEnd) {
    return true;
  }

  // 明确的连接词收尾（无句号结尾时）
  if (/(?:的是|就是|以及|并且|而且|同时|另外|此外|也就是|例如|比如)$/.test(t) && noSentenceEnd) {
    return true;
  }

  return false;
}

function hasTruncateMarker(text) {
  const cfg = getConfig();
  const { outsideText } = extractFencedBlocks(text);
  const tail = outsideText.slice(-cfg.markerWindow).toLowerCase();
  return cfg.truncateMarkers.some((m) => tail.includes(m.toLowerCase()));
}

/**
 * 检测响应末尾是否出现 error 关键词（强制续跑信号）
 * 激进策略：
 *   1. 短文本（< 100 字符）全文检查
 *   2. 长文本只检查最后两句
 *   3. 如果已正常收束，则不触发（技术讨论场景）
 */
function hasErrorKeyword(text) {
  const cfg = getConfig();
  if (!cfg.enableErrorKeyword) return false;

  const trimmed = text.trimEnd();
  if (!trimmed) return false;

  if (looksComplete(text)) return false;

  const errorKeywords = [
    'error', 'exception', 'failed', 'failure', 'timeout',
    '错误', '异常', '失败', '超时', '中断',
    // 第三方网关错误特征（new-api / one-api 类代理）
    'do_request_failed', 'bad_response_status_code', 'new_api_error',
    '上游问题', '渠道出错', '渠道错误', '上游接口不存在',
  ];

  const { outsideText } = extractFencedBlocks(text);
  const checkText = outsideText.trimEnd();
  if (!checkText) return false;

  // 短文本（< 100 字符）全文检查
  if (checkText.length < 100) {
    const lower = checkText.toLowerCase();
    return errorKeywords.some(kw => lower.includes(kw));
  }

  // 长文本按句子分割，检查最后两句
  const sentences = checkText.split(/[。！？!?\n]+/).filter(s => s.trim());
  if (sentences.length === 0) return false;

  const lastTwoSentences = sentences.slice(-2).join(' ').toLowerCase();
  return errorKeywords.some(kw => lastTwoSentences.includes(kw));
}


function looksComplete(text) {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  if (!codeBlocksBalanced(text)) return false;
  if (isShortAck(trimmed)) return true;
  if (endsWithNormalClosing(trimmed) || endsWithSentenceEnd(trimmed)) return true;
  return false;
}

/**
 * 判定 last_assistant_message 是否被 API 错误截断。
 * 策略：强信号优先；无明确截断信号则保守放行。
 * 增加决策路径日志，便于调试和优化。
 * @returns {boolean}
 */
function isInterrupted(message) {
  const cfg = getConfig();
  const decisions = []; // 记录每个规则的判定结果

  // null/undefined 响应 → API 错误，触发续跑
  if (message === null || message === undefined) {
    decisions.push({ rule: 'null_or_undefined', result: true });
    debugLog({ decisions, final: 'interrupted' });
    return true;
  }

  if (typeof message !== 'string') {
    decisions.push({ rule: 'invalid_type', result: false });
    debugLog({ decisions, final: 'allow' });
    return false;
  }

  const text = message;
  const trimmed = text.trimEnd();

  // 空串 —— 一字未出就中断
  if (trimmed.length === 0) {
    decisions.push({ rule: 'empty_response', result: true });
    debugLog({ decisions, final: 'interrupted' });
    return true;
  }

  // 缓存重复计算
  const lowerText = trimmed.toLowerCase();

  // **API 拒绝类响应强制续跑**
  if (cfg.enableRefusalPattern) {
    const refusalPatterns = [
      "can't help",
      "cannot help",
      "can not help",
      "start a new session",
      "unable to assist",
      "unable to help",
      "不能帮助",
      "无法帮助",
      "无法协助",
      ...cfg.customRefusalPatterns,
    ];
    const hasRefusal = refusalPatterns.some(pattern => lowerText.includes(pattern));
    decisions.push({ rule: 'refusal_pattern', result: hasRefusal });
    if (hasRefusal) {
      debugLog({ decisions, final: 'interrupted', matchedPattern: refusalPatterns.find(p => lowerText.includes(p)) });
      return true;
    }
  }

  // 代码块未闭合
  const isBalanced = codeBlocksBalanced(text);
  decisions.push({ rule: 'code_blocks_balanced', result: !isBalanced });
  if (!isBalanced) {
    debugLog({ decisions, final: 'interrupted' });
    return true;
  }

  // **error 关键词强制续跑（优先级高）**
  const hasError = hasErrorKeyword(text);
  decisions.push({ rule: 'error_keyword', result: hasError });
  if (hasError) {
    debugLog({ decisions, final: 'interrupted' });
    return true;
  }

  // 正常收束 / 短确认 → 不续跑
  const looksGood = looksComplete(text);
  decisions.push({ rule: 'looks_complete', result: !looksGood });
  if (looksGood) {
    debugLog({ decisions, final: 'allow' });
    return false;
  }

  // 极短且非确认 —— 刚开头就被掐断
  if (trimmed.length < cfg.tooShortLength) {
    decisions.push({ rule: 'too_short', result: true, length: trimmed.length });
    debugLog({ decisions, final: 'interrupted' });
    return true;
  }

  // 半句标点收尾
  const hasHalfPunc = trailingHalfPunctuation(trimmed);
  decisions.push({ rule: 'half_punctuation', result: hasHalfPunc });
  if (hasHalfPunc) {
    debugLog({ decisions, final: 'interrupted' });
    return true;
  }

  // 括号未配平：仅当左括号未闭合才视为截断（右括号多余在技术回复里常见）
  const bracketsOk = bracketsBalanced(text);
  decisions.push({ rule: 'brackets_balanced', result: !bracketsOk });
  if (!bracketsOk) {
    debugLog({ decisions, final: 'interrupted' });
    return true;
  }

  // 延续性收尾
  const hasContinuation = trailingContinuation(trimmed);
  decisions.push({ rule: 'trailing_continuation', result: hasContinuation });
  if (hasContinuation) {
    debugLog({ decisions, final: 'interrupted' });
    return true;
  }

  // 末尾窗口截断特征词
  const hasMarker = hasTruncateMarker(text);
  decisions.push({ rule: 'truncate_marker', result: hasMarker });
  if (hasMarker) {
    debugLog({ decisions, final: 'interrupted' });
    return true;
  }

  // 无明确截断信号 → 保守放行（中文常省略句号）
  decisions.push({ rule: 'no_signal', result: false });
  debugLog({ decisions, final: 'allow' });
  return false;
}

function emitContinue(detectedBy) {
  const prompt = getContinuePrompt();
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: prompt,
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: prompt,
      detectedBy: detectedBy || 'unknown',
      version: '0.3.5',
    },
  }));
}

function emitAllow() {
  process.stdout.write('{}');
}

// ────────────── 主流程 ──────────────
async function main() {
  const raw = await readStdin();

  let payload = {};
  if (raw && raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      debugLog({ action: 'allow', reason: 'invalid_json', rawPreview: String(raw).slice(0, 200) });
      emitAllow();
      return;
    }
  } else {
    debugLog({ action: 'allow', reason: 'empty_stdin' });
  }

  const msg = payload.last_assistant_message;
  const msgPreview = typeof msg === 'string'
    ? msg.slice(-120)
    : msg;

  if (payload.stop_hook_active === true) {
    debugLog({ action: 'allow', reason: 'stop_hook_active', msgPreview });
    emitAllow();
    return;
  }

  if (
    payload.stop_reason === 'user_stop'
    || payload.user_initiated === true
    || payload.reason === 'user_interrupt'
  ) {
    debugLog({
      action: 'allow',
      reason: 'user_stop',
      stop_reason: payload.stop_reason,
      user_initiated: payload.user_initiated,
      msgPreview,
    });
    emitAllow();
    return;
  }

  if (isInterrupted(msg)) {
    // 从 decisions 日志中提取触发原因
    const triggeredRule = msg === null || msg === undefined ? 'null_response'
      : typeof msg === 'string' && msg.trimEnd().length === 0 ? 'empty_response'
      : 'interrupted';

    debugLog({
      action: 'block',
      reason: 'interrupted',
      stop_reason: payload.stop_reason,
      hook_event_name: payload.hook_event_name,
      msgLen: typeof msg === 'string' ? msg.length : null,
      msgPreview,
      payloadKeys: Object.keys(payload),
    });
    emitContinue(triggeredRule);
    return;
  }

  debugLog({
    action: 'allow',
    reason: 'looks_complete_or_no_signal',
    stop_reason: payload.stop_reason,
    hook_event_name: payload.hook_event_name,
    msgLen: typeof msg === 'string' ? msg.length : null,
    msgPreview,
    payloadKeys: Object.keys(payload),
  });
  emitAllow();
}

main().catch(() => {
  try { emitAllow(); } catch { /* ignore */ }
});
