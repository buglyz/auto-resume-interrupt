#!/bin/bash
# auto-resume-interrupt 完整测试套件

set -e

S="../scripts/resume-check.js"
PASS=0
FAIL=0

# 颜色输出
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

assert_block() {
  local input="$1"
  local desc="$2"
  local output=$(echo "$input" | node "$S")

  if [[ "$output" == *'"decision":"block"'* ]]; then
    echo -e "${GREEN}✅ PASS${NC}: $desc"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}❌ FAIL${NC}: $desc"
    echo "   Input: $input"
    echo "   Output: $output"
    FAIL=$((FAIL + 1))
  fi
}

assert_allow() {
  local input="$1"
  local desc="$2"
  local output=$(echo "$input" | node "$S")

  if [[ "$output" == "{}" ]]; then
    echo -e "${GREEN}✅ PASS${NC}: $desc"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}❌ FAIL${NC}: $desc"
    echo "   Input: $input"
    echo "   Output: $output"
    FAIL=$((FAIL + 1))
  fi
}

echo -e "${YELLOW}=== 基础截断测试 ===${NC}"
assert_block '{"stop_hook_active":false,"last_assistant_message":""}' "空响应"
assert_block '{"stop_hook_active":false,"last_assistant_message":null}' "null 响应"
assert_block '{"stop_hook_active":false,"last_assistant_message":"好的，我来实现这个功能，首先我"}' "句中截断"
assert_block '{"stop_hook_active":false,"last_assistant_message":"```python\ndef foo():"}' "代码块未闭合"

echo ""
echo -e "${YELLOW}=== API 拒绝响应测试 ===${NC}"
assert_block '{"stop_hook_active":false,"last_assistant_message":"Fable 5 can'\''t help"}' "can't help"
assert_block '{"stop_hook_active":false,"last_assistant_message":"I cannot help with this"}' "cannot help"
assert_block '{"stop_hook_active":false,"last_assistant_message":"Please start a new session"}' "start a new session"
assert_block '{"stop_hook_active":false,"last_assistant_message":"无法帮助你完成这个任务"}' "中文拒绝"

echo ""
echo -e "${YELLOW}=== error 关键词测试 ===${NC}"
assert_block '{"stop_hook_active":false,"last_assistant_message":"Connection error"}' "短 error 消息"
assert_block '{"stop_hook_active":false,"last_assistant_message":"API error"}' "API error（<100字符）"
assert_block '{"stop_hook_active":false,"last_assistant_message":"API rate limit exceeded"}' "rate limit"
assert_block '{"stop_hook_active":false,"last_assistant_message":"Request timeout"}' "timeout"
assert_block '{"stop_hook_active":false,"last_assistant_message":"出现异常"}' "中文异常"
assert_block '{"stop_hook_active":false,"last_assistant_message":"操作失败"}' "中文失败"

echo ""
echo -e "${YELLOW}=== 延续性收尾测试 ===${NC}"
assert_block '{"stop_hook_active":false,"last_assistant_message":"好的，接下来我"}' "逗号 + 延续词"
assert_block '{"stop_hook_active":false,"last_assistant_message":"首先我"}' "延续词（很短）"
assert_block '{"stop_hook_active":false,"last_assistant_message":"好，然后我"}' "逗号 + 然后我"

echo ""
echo -e "${YELLOW}=== 半句标点测试 ===${NC}"
assert_block '{"stop_hook_active":false,"last_assistant_message":"这个功能需要修改，"}' "逗号结尾"
assert_block '{"stop_hook_active":false,"last_assistant_message":"主要步骤："}' "冒号结尾"
assert_block '{"stop_hook_active":false,"last_assistant_message":"包括以下内容；"}' "分号结尾"

echo ""
echo -e "${YELLOW}=== 括号配平测试 ===${NC}"
assert_block '{"stop_hook_active":false,"last_assistant_message":"function foo("}' "左圆括号未闭合"
assert_block '{"stop_hook_active":false,"last_assistant_message":"array[0"}' "左方括号未闭合"
assert_block '{"stop_hook_active":false,"last_assistant_message":"{\"key\":"}' "左花括号未闭合"

echo ""
echo -e "${YELLOW}=== 截断特征词测试 ===${NC}"
assert_block '{"stop_hook_active":false,"last_assistant_message":"好的，我来修改... 502 Bad Gateway"}' "502 错误"
assert_block '{"stop_hook_active":false,"last_assistant_message":"正在连接... connection reset by peer"}' "connection reset"
assert_block '{"stop_hook_active":false,"last_assistant_message":"请求中... gateway timeout"}' "gateway timeout"

echo ""
echo -e "${YELLOW}=== 应该放行的场景 ===${NC}"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"任务已完成。"}' "正常完成"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"以上是本次改动，请验收。"}' "请验收"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"好的"}' "短确认：好的"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"可以了"}' "短确认：可以了"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"没问题"}' "短确认：没问题"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"OK"}' "短确认：OK"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"Done"}' "短确认：Done"

echo ""
echo -e "${YELLOW}=== 守门机制测试 ===${NC}"
assert_allow '{"stop_hook_active":true,"last_assistant_message":"好的我来"}' "stop_hook_active 守门"
assert_allow '{"stop_hook_active":false,"stop_reason":"user_stop","last_assistant_message":"好的我来"}' "用户主动停止"
assert_allow '{"stop_hook_active":false,"user_initiated":true,"last_assistant_message":"好的我来"}' "user_initiated"

echo ""
echo -e "${YELLOW}=== 误判防护测试 ===${NC}"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"可以，首先我确认一下需求。"}' "完整短句不误判"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"这个问题是由于 connection error 导致的，已经修复。"}' "技术讨论不误判（完整句 + 句号）"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"报错信息是 API error，请检查配置。"}' "技术讨论不误判（error 但完整）"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"好的，首先我确认一下这个需求的具体细节和实现方案。"}' "完整长句不误判"

echo ""
echo -e "${YELLOW}=== 边界场景测试（新增）===${NC}"
assert_block '{"stop_hook_active":false,"last_assistant_message":"我修改了 function foo(。"}' "句号结尾但括号未闭合"
assert_block '{"stop_hook_active":false,"last_assistant_message":"好的接下来我将要实现这个功能，然后我"}' "长句延续词（>= 30 字符）"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"任务完成，详情见上文。"}' "正常句号结尾（放行对照）"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"我需要确认"}' "单字收束词放行（我需要确认）"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"请参考"}' "单字收束词放行（请参考）"

echo ""
echo -e "${YELLOW}=== 代码块内括号不误判（核心修复）===${NC}"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"已修复。代码如下：\n```json\n{\"decision\":\"block\",\"reason\":\"...\"}\n```\n以上。"}' "JSON 代码块不误判"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"配置如下：\n```javascript\nconst obj = {a: 1, b: [2, 3]};\nfunc(\n```\n等等，这里没闭合"}' "代码块内括号不影响判定"
assert_allow '{"stop_hook_active":false,"last_assistant_message":"输出是 `{\"decision\":\"block\"}`，符合 schema。"}' "行内代码含括号不误判"

echo ""
echo -e "${YELLOW}=== 测试总结 ===${NC}"
echo -e "通过: ${GREEN}$PASS${NC}"
echo -e "失败: ${RED}$FAIL${NC}"
echo -e "总计: $((PASS + FAIL))"

if [ $FAIL -gt 0 ]; then
  echo -e "${RED}有测试失败！${NC}"
  exit 1
else
  echo -e "${GREEN}所有测试通过！${NC}"
  exit 0
fi
