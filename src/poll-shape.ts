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
  // As of the 2026-08-23 server-side fix, actions[] is button cards ONLY:
  // {label, url, style}. Before that fix it also carried the tool-call log
  // ({tool, args, result}) mixed into the same array — the server had a
  // jsonb key collision (metadata[:actions] symbol vs metadata["actions"]
  // string both serialised to "actions") that silently discarded the log on
  // any turn that also produced buttons. Historical rows written before the
  // fix may still show that mixed shape here — see toolResultsText's
  // fallback below, which still reads tool-log entries out of actions[] for
  // those rows.
  actions?: Array<{
    label?: string; url?: string; style?: string;
    tool?: string; args?: unknown; result?: Record<string, unknown>;
  }> | null;
  // The tool-call chain log for this turn — {tool, args, result} per hop.
  // Present (its own key, split out of actions[]) on messages written after
  // the 2026-08-23 fix. Absent (undefined) on historical rows, which carried
  // the same data mixed into actions[] instead — see toolResultsText.
  tool_calls?: Array<{
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
// the tool-call log. Kept compact and truncated on purpose — this is a fallback
// for outcome data, not a JSON dump of every tool call.
//
// Reads tool_calls (its own key as of the 2026-08-23 server fix) when present;
// falls back to actions[] only for a message that predates the fix (tool_calls
// absent there — the log used to be mixed into actions[] before the jsonb key
// collision was split apart, see PollMessage's doc comment). Per message we
// pick ONE source, never both, so a message can't double-report; the `seen`
// set below is a second, defensive guard in case a row somehow carries the
// same tool+args+result in both places.
export function toolResultsText(msgs: PollMessage[]): string {
  const lines: string[] = [];
  // Keyed on message_id + tool + args + result — NOT tool+result alone.
  // Two distinct calls to the same tool with the same result payload but
  // different args (e.g. two approve_feed_item calls that both return
  // scheduled: 0, for two different feed_item_ids) must both be reported;
  // keying on tool+result only would collapse them into one line and hide
  // one of the two scheduled counts, which is exactly what this function
  // exists to surface.
  const seen = new Set<string>();
  for (const m of msgs) {
    const source = m.tool_calls != null ? m.tool_calls : m.actions || [];
    for (const a of source) {
      if (!a || !a.result) continue;
      if (a.tool && CARD_COVERED_TOOLS.includes(a.tool)) continue;
      let rendered: string;
      try {
        rendered = JSON.stringify(a.result);
      } catch {
        rendered = String(a.result);
      }
      let renderedArgs: string;
      try {
        renderedArgs = JSON.stringify(a.args);
      } catch {
        renderedArgs = String(a.args);
      }
      const key = `${m.message_id}:${a.tool || "tool"}:${renderedArgs}:${rendered}`;
      if (seen.has(key)) continue;
      seen.add(key);
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

export type ActionResult = {
  confirmation_required?: boolean;
  message_id?: number;
  success?: boolean;
  message?: string;
  error?: string;
  updated_fields?: string[];
  // approve_feed_item: how many platforms the piece was actually scheduled to.
  // 0 means it went nowhere (nothing connected that accepts this content).
  scheduled?: number;
  // The sentence the server wrote FOR THE OWNER TO READ, computed from what
  // actually happened (server-side: 2026-09-13). `message` is written for the
  // model; the two are deliberately different. The server added this field
  // because a fixed lookup table had been overwriting the computed receipt —
  // "queued for sending" was shown even when zero ad channels accepted the
  // piece. Fixed wording is not evidence of a result.
  //
  // Declared by the server at GET /api/contract as `receipt_field`.
  receipt_text?: string;
};

export function formatAction(result: ActionResult): string {
  if (result.confirmation_required) {
    return `[Confirmation required] Call autowhisper_confirm with message_id=${result.message_id} and decision="yes" to proceed, or "no" to decline.`;
  }
  // receipt_text wins over message. The server computes it from the actual
  // outcome and writes it for the owner to read; message is aimed at the model
  // and can be the generic one. Preferring message here is how an agent ends up
  // saying "queued for sending" about a piece that no channel accepted.
  const message = result.receipt_text || result.message || "Done.";
  // `message` is localized to the OWNER's language — an English-speaking agent
  // cannot be expected to read 「已批准并排期发布到 Facebook」 or, worse, to notice
  // that 「尚未绑定任何社交平台」 means nothing went out. Approving publishes, so
  // "did it actually go anywhere" is the fact that matters most here; state it in
  // a language-neutral form alongside the human sentence.
  if (typeof result.scheduled === "number") {
    return result.scheduled > 0
      ? `${message}\n(scheduled to ${result.scheduled} platform${result.scheduled === 1 ? "" : "s"})`
      : `${message}\n(nothing was scheduled — no connected platform accepts this content. Connecting one later does NOT publish it; approve again or publish it explicitly.)`;
  }
  return message;
}

// autowhisper_confirm used to discard the response body entirely and return a
// fixed "Done — the action was performed." string on every "yes" — including
// approve_feed_item confirmations where `result.scheduled: 0` means the post
// went nowhere. That is the exact silent-success failure this branch exists to
// eliminate; reuse formatAction's wording instead of inventing new phrasing, so
// the confirm path and the direct-action path never say different things for
// the same result shape.
//
// `decision` here is the value the caller passed to the tool (not re-derived
// from the response body), so a "no" always renders "Declined." even if the
// server body is absent or fails to parse — see readBody in index.ts, which
// never throws and instead degrades to an unparsed snippet.
export function formatConfirmResult(decision: "yes" | "no", result: ActionResult | null | undefined): string {
  if (decision === "no") return "Declined.";
  if (!result) return "Done — the action was performed.";
  return formatAction(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/performance (server-side since 2026-09-01; wired here 2026-09-21)
// ─────────────────────────────────────────────────────────────────────────────

export type Performance = {
  scope?: string;
  workspace_id?: number;
  period?: { from?: string; to?: string };
  layers?: Record<string, number>;
  layer_sources?: Record<string, string>;
  by_channel?: Record<string, Record<string, number>>;
  // ⚠️ null and 0 are DIFFERENT answers here and the server means it: null is
  // "we cannot tell you" (no active workspace), 0 is "nothing was spent".
  // Collapsing them with `?? 0` invents a fact about the owner's ad budget.
  ad_spend_cents?: number | null;
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatPerformance(data: Performance | null | undefined): string {
  const d = data || {};
  const lines: string[] = [];

  const from = d.period?.from?.slice(0, 10);
  const to = d.period?.to?.slice(0, 10);
  lines.push(`Performance${d.workspace_id ? ` for workspace ${d.workspace_id}` : ""}${from && to ? ` (${from} → ${to})` : ""}:`);

  const layers = Object.entries(d.layers || {});
  if (layers.length === 0) {
    // Say so rather than printing an empty funnel: an empty funnel reads as
    // "everything is zero", which is a claim, not the absence of one.
    lines.push("  No funnel data for this window.");
  } else {
    for (const [name, value] of layers) {
      const source = d.layer_sources?.[name];
      lines.push(`  ${name}: ${value}${source ? ` (${source})` : ""}`);
    }
  }

  const channels = Object.entries(d.by_channel || {});
  if (channels.length > 0) {
    lines.push("By channel:");
    for (const [channel, stats] of channels) {
      const parts = Object.entries(stats || {}).map(([k, v]) => `${k}=${v}`).join(", ");
      lines.push(`  ${channel}: ${parts || "no data"}`);
    }
  }

  lines.push(
    d.ad_spend_cents === null || d.ad_spend_cents === undefined
      ? "Ad spend: unknown (no active workspace to read)"
      : `Ad spend: ${money(d.ad_spend_cents)}`,
  );

  return lines.join("\n");
}
