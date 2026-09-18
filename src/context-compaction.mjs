// 上下文压缩：长会话在切换模型时最容易断——历史已经比新模型的窗口大，客户端还没来得及压缩
// 就把请求发出来了。网关这一层能看见完整请求，所以由这里兜底：把较早的部分压成摘要，
// 保留最近的完整对话，让用户在同一段对话里继续，而不是被迫新开会话或换模型。
//
// 这个文件只放纯函数（不碰网络、不碰磁盘），压缩策略要能单独测。

// JSON 里一个 token 大约 3–4 字节。取 3.2 是刻意偏保守：宁可高估一点提前压缩，
// 也不要算少了把请求发出去、等一分钟再收到供应商的 400。
export const bytesPerToken = 3.2;

export function estimateTokens(payload, bodyBytes) {
  const output = Number(payload?.max_output_tokens) > 0 ? Number(payload.max_output_tokens) : 0;
  return Math.round((Number(bodyBytes) || 0) / bytesPerToken) + output;
}

function itemBytes(item) {
  try { return JSON.stringify(item ?? "").length; } catch { return 0; }
}

function itemKind(item) {
  return String(item?.type ?? (item?.role ? `message:${item.role}` : ""));
}

const toolOutputKinds = new Set(["function_call_output", "custom_tool_call_output"]);

// 切点必须落在「一条普通用户消息」上：往前挪会把工具调用和它的输出拆开，
// 供应商会因为「工具结果找不到对应的调用」直接 400。
export function safeSplitIndex(items, keepBudgetBytes) {
  if (!Array.isArray(items) || items.length < 4) return 0;
  let budget = 0;
  let split = items.length;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    budget += itemBytes(items[index]);
    if (budget >= keepBudgetBytes) { split = index; break; }
  }
  if (split >= items.length) return 0;
  // 从候选点往后找最近的用户消息，保证尾巴从「用户提问」开始。
  let snapped = split;
  while (snapped < items.length && itemKind(items[snapped]) !== "message:user") snapped += 1;
  if (snapped >= items.length || snapped === 0) return 0;
  // 尾巴开头不能是「工具输出」：那说明它的调用被留在摘要里了。
  let head = snapped;
  while (head < items.length && toolOutputKinds.has(itemKind(items[head]))) head += 1;
  if (head >= items.length) return 0;
  return head;
}

export function transcriptOf(headItems, limitChars = 400000) {
  return headItems.map((item) => {
    const kind = itemKind(item);
    if (kind === "message:user" || kind === "message:assistant") {
      const text = typeof item.content === "string"
        ? item.content
        : (item.content ?? []).map((part) => part?.text ?? "").join("");
      return `${kind === "message:user" ? "用户" : "助手"}：${text}`;
    }
    if (kind === "function_call" || kind === "custom_tool_call") {
      return `助手调用工具 ${item.name ?? ""}（参数从略）`;
    }
    if (toolOutputKinds.has(kind)) {
      const text = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      return `工具返回：${text.slice(0, 2000)}`;
    }
    return "";
  }).filter(Boolean).join("\n").slice(0, limitChars);
}

export function summaryRequest(transcript, model) {
  return {
    model,
    instructions: [
      "你正在为一个长会话做上下文压缩。下面是被裁掉的前半段记录。",
      "请输出一份可直接替代这些记录的摘要，要求：",
      "1) 保留当前任务目标、已确定的决策与结论、关键文件路径、命令、参数、错误信息与版本号；",
      "2) 保留尚未完成的待办与下一步计划；",
      "3) 保留用户明确提出的要求、偏好与禁忌；",
      "4) 丢弃寒暄、重复内容和已经完成的中间过程；",
      "5) 用紧凑的中文条目式输出，不要加客套话，不要解释你在做什么。",
    ].join("\n"),
    input: [{ role: "user", content: [{ type: "input_text", text: transcript }] }],
    max_output_tokens: 4000,
    stream: false,
  };
}

export function extractSummary(result) {
  if (!result) return "";
  if (typeof result.output_text === "string" && result.output_text.trim()) return result.output_text.trim();
  const parts = [];
  for (const item of result.output ?? []) {
    if (item?.type === "message") {
      for (const part of item.content ?? []) if (part?.text) parts.push(part.text);
    } else if (item?.type === "text" && item.text) parts.push(item.text);
  }
  return parts.join("\n").trim();
}

export function buildCompactedInput({ summary, tail, droppedCount }) {
  const note = [
    `【较早对话已压缩】以下是前 ${droppedCount} 条记录（用户消息、工具调用与返回）的摘要，`,
    "用于保持上下文连续；细节如需可让用户重新提供。",
    "",
    summary,
  ].join("\n");
  return [{ role: "user", content: [{ type: "input_text", text: note }] }, ...tail];
}

// 兜底摘要：连摘要模型都调不通时，至少把「丢了什么」如实列出来，绝不静默丢上下文。
export function fallbackSummary(headItems) {
  const lines = headItems
    .filter((item) => itemKind(item) === "message:user")
    .map((item) => {
      const text = typeof item.content === "string"
        ? item.content
        : (item.content ?? []).map((part) => part?.text ?? "").join("");
      return `- ${text.replace(/\s+/g, " ").slice(0, 160)}`;
    })
    .slice(-40);
  return [
    "（摘要模型本次不可用，以下是被裁掉的用户消息开头，供接续参考）",
    ...lines,
  ].join("\n");
}
