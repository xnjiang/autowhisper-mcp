/**
 * Shape of a CMO poll message, plus pure helpers built on it.
 *
 * Extracted so they can be unit-tested. index.ts calls main() at module load —
 * it starts the MCP server and connects a stdio transport — so importing it
 * from a test would hang or corrupt the test run. Mirrors fast-read.ts's split:
 * pure logic lives here, index.ts imports it.
 */

export type PollMessage = {
  message_id: number;
  role: string;
  content: string;
  message_kind?: string | null;
  pending_action?: { tool?: string; args?: unknown } | null;
  // ⚠️ 两种形态混在同一个数组里:
  //   · 工具调用日志 {tool, args, result}
  //   · 可点击卡片   {label, url, style}
  // 只按 url 过滤会把工具结果整个丢掉 —— 0.5.0 就是这么丢的。
  actions?: Array<{
    label?: string; url?: string; style?: string;
    tool?: string; args?: unknown; result?: Record<string, unknown>;
  }> | null;
  // CMO 把部分工具结果 lift 成成品卡片,并被明确指示【正文不复述】。
  // 只读 content 的话,一句「建议在下面的卡片里」就是全部内容。
  cards?: Record<string, Record<string, unknown>> | null;
};

// ⚠️ 轮询是按工作区作用域的。不带 workspace_id 时服务端回落到
// workspaces.active.first,于是发到别的工作区的那一轮永远 404 ——
// 2026-08-22 真机复现:send 成功、轮询 40 次全 404、报「还在跑」。
export function pollUrl(mid: number, workspaceId?: number): string {
  return workspaceId === undefined
    ? `/api/cmo/messages/${mid}`
    : `/api/cmo/messages/${mid}?workspace_id=${workspaceId}`;
}

const CARD_BODY_KEYS = ["advice", "guidance", "message"] as const;

export function cardText(msgs: PollMessage[]): string {
  const blocks: string[] = [];
  for (const m of msgs) {
    for (const card of Object.values(m.cards || {})) {
      if (!card) continue;
      const body = CARD_BODY_KEYS.map((k) => card[k]).find((v) => typeof v === "string" && v.trim());
      if (!body) continue;
      const heading = typeof card.heading === "string" ? card.heading : "";
      blocks.push(heading ? `## ${heading}\n\n${body}` : String(body));
    }
  }
  return blocks.join("\n\n");
}

// Tools whose result payload is already rendered by `cardText` above (via
// `cards`). Keeping this list next to CARD_BODY_KEYS makes the coupling
// visible: if the server lifts a new tool into `cards`, this list needs the
// same addition or its result gets reported twice.
export const CARD_COVERED_TOOLS = ["recommend_targeting", "activation_guide", "generate_inquiry_opener"];

const TOOL_RESULT_MAX_CHARS = 300;

// Everything else that ran as a tool call — most importantly approve_feed_item,
// whose `result.scheduled` (how many platforms a piece actually went to; 0 means
// nowhere) is never lifted into `cards`. Without this, SKILL.md's instruction to
// report `scheduled` is unfollowable on the chat path: the number exists only in
// actions[].result. Kept compact and truncated on purpose — this is a fallback
// for outcome data, not a JSON dump of every tool call.
export function toolResultsText(msgs: PollMessage[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    for (const a of m.actions || []) {
      if (!a || !a.result) continue;
      if (a.tool && CARD_COVERED_TOOLS.includes(a.tool)) continue;
      let rendered: string;
      try {
        rendered = JSON.stringify(a.result);
      } catch {
        rendered = String(a.result);
      }
      if (rendered.length > TOOL_RESULT_MAX_CHARS) rendered = `${rendered.slice(0, TOOL_RESULT_MAX_CHARS)}…`;
      lines.push(`- ${a.tool || "tool"}: ${rendered}`);
    }
  }
  return lines.length ? `Tool results:\n${lines.join("\n")}` : "";
}

// The full reply-assembly, pulled out so the wiring (does `cards`/`toolResults`
// actually reach the combined text?) is unit-testable. index.ts's registerTool
// handler is not directly testable (see module header), so this is the closest
// thing to a regression test for that call site.
export function composeReply(parts: {
  reply: string;
  cards: string;
  toolResults: string;
  links: string;
  wsNote: string;
}): string {
  return [parts.reply, parts.cards, parts.toolResults, parts.links, parts.wsNote].filter(Boolean).join("\n\n");
}
