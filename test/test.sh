#!/usr/bin/env bash
# 自动化测试套件

set -e
S="../scripts/resume-check.js"

pass_count=0
fail_count=0

assert_block() {
  local input="$1"
  local desc="$2"
  local output=$(echo "$input" | node "$S")
  if [[ "$output" == *'"decision":"block"'* ]]; then
    echo "✅ PASS: $desc"
    ((pass_count++))
  else
    echo "❌ FAIL: $desc"
    echo "   Input: $input"
    echo "   Output: $output"
    ((fail_count++))
  fi
}

assert_allow() {
  local input="$1"
  local desc="$2"
  local output=$(echo "$input" | node "$S")
  if [[ "$output" == "{}" ]]; then
    echo "✅ PASS: $desc"
    ((pass_count++))
  else
    echo "❌ FAIL: $desc"
    echo "   Input: $input"
    echo "   Output: $output"
    ((fail_count++))
  fi
}

echo "=========================================="
echo "auto-resume-interrupt 测试套件"
echo "=========================================="
echo ""

echo "【1. 应该触发续跑的场景】"
echo "----------------------------------------"

# 基础截断场景
assert_block '{"stop_hook_active":false,"last_assistant_message":"好的，我来实现这个功能，首先我"}' "句中截断"
assert_block '{"stop_hook_active":false,"last_assistant_message":""}' "空响应"
assert_block '{"stop_hook_active":false,"last_assistant_message":"```python\ndef foo():"}' "代码块未闭合"
assert_block '{"stop_hook_active":false,"last_assistant_message":"数据是 {a: 1,"}' "括号未闭合"
assert_block '{"stop_hook_active":false,"last_assistant_message":"首先，"}' "半句标点"
assert_block '{"stop_hook_active":false,"last_assistant_message":"我来"}' "极短响应（< 5字符）"

# API 错误场景
assert_block '{"stop_hook_active":false,"last_assistant_message":null}' "null 响应"
assert_block '{"stop_hook_active":false,"last_assistant_message":"Fable 5 can'\''t help with this"}' "API 拒绝响应"
assert_block '{"stop_hook_active":false,"last_assistant_message":"Start a new session"}' "新会话提示"
assert_block '{"stop_hook_active":false,"last_assistant_message":"unable to assist"}' "无法协助"

# error 关键词场景
assert_block '{"stop_hook_active":false,"last_assistant_message":"Connection error"}' "末尾 error"
assert_block '{"stop_hook_active":false,"last_assistant_message":"API error occurred"}' "API error"
assert_block '{"stop_hook_active":false,"last_assistant_message":"Request timeout"}' "timeout"
assert_block '{"stop_hook_active":false,"last_assistant_message":"Exception occurred"}' "exception"
assert_block '{"stop_hook_active":false,"last_assistant_message":"连接失败"}' "中文：失败"
assert_block '{"stop_hook_active":false,"last_assistant_message":"请求超时"}' "中文：超时"
assert_block '{"stop_hook_active":false,"last_assistant_message":"API rate limit exceeded"}' "Rate limit"
assert_block '{"stop_hook_active":false,"last_assistant_message":"请检查配置。API error occurred"}' "倒数第一句有 error"

# 网络错误特征词
assert_block '{"stop_hook_active":false,"last_assistant_message":"connection reset by peer"}' "connection reset"
assert_block '{"stop_hook_active":false,"last_assistant_message":"502 bad gateway"}' "502 错误"
assert_block '{"stop_hook_active":false,"last_assistant_message":"service unavailable"}' "服务不可用"

# 括号严格配平（右括号多余）
assert_block '{"stop_hook_active":false,"last_assistant_message":"数据是 {a: 1}}"}' "右括号多余"

echo ""
echo "【2. 应该放行的场景】"
echo "----------------------------------------"

# 正常完成
assert_allow '{"stop_hook_active":false,"last_assistant_message":"任务已完成。"}' "正常完成"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"以上是本次改动，请验收"}' "请验收"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"实现完成，请查看"}' "请查看"

# 短确认白名单
assert_allow '{"stop_hook_active":false,"last_assistant_message":"好的"}' "短确认：好的"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"可以"}' "短确认：可以"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"可以了"}' "短确认：可以了"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"没问题"}' "短确认：没问题"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"收到了"}' "短确认：收到了"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"ok"}' "短确认：ok"

# 守门机制
assert_allow '{"stop_hook_active":true,"last_assistant_message":"好的我来"}' "stop_hook_active 守门"
assert_allow '{"stop_hook_active":false,"stop_reason":"user_stop","last_assistant_message":"好的我来"}' "用户主动停止"
assert_allow '{"stop_hook_active":false,"user_initiated":true,"last_assistant_message":"好的我来"}' "用户发起"

# error 关键词但已正常收束（技术讨论）
assert_allow '{"stop_hook_active":false,"last_assistant_message":"这个问题是由于 connection error 导致的，已经修复。"}' "技术讨论（完整句 + 句号）"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"API error occurred。请稍后重试。任务已完成"}' "error 在第三句（超出范围）"

# 代码块闭合
assert_allow '{"stop_hook_active":false,"last_assistant_message":"```python\ndef foo():\n    return 1\n```\n\n实现完成"}' "代码块已闭合"

echo ""
echo "=========================================="
echo "测试结果"
echo "=========================================="
echo "通过: $pass_count"
echo "失败: $fail_count"
echo ""

if [ $fail_count -eq 0 ]; then
  echo "🎉 所有测试通过！"
  exit 0
else
  echo "❌ 有 $fail_count 个测试失败"
  exit 1
fi
