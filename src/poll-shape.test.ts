import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pollUrl,
  cardText,
  toolResultsText,
  composeReply,
  formatAction,
  formatConfirmResult,
  formatPerformance,
  type PollMessage,
} from "./poll-shape.js";

test("pollUrl carries workspace_id — polling is workspace-scoped", () => {
  assert.equal(pollUrl(42, 183), "/api/cmo/messages/42?workspace_id=183");
});

test("pollUrl omits the query when no workspace was given", () => {
  assert.equal(pollUrl(42, undefined), "/api/cmo/messages/42");
});

test("cardText surfaces advice the prose deliberately omits", () => {
  const msgs: PollMessage[] = [
    {
      message_id: 1,
      role: "assistant",
      content: "建议已经整理在下面的卡片里了。",
      cards: { targeting_advice: { heading: "Your targeting plan", advice: "Start on Meta. Markets: US, UK." } },
    },
  ];
  const out = cardText(msgs);
  assert.match(out, /Start on Meta/);
  assert.match(out, /Your targeting plan/);
});

test("cardText is empty when the turn lifted no cards", () => {
  const msgs: PollMessage[] = [{ message_id: 1, role: "assistant", content: "hello" }];
  assert.equal(cardText(msgs), "");
});

// This is the case that matters: approve_feed_item's `scheduled` (how many
// platforms a piece actually went to; 0 means nowhere) lives ONLY in
// actions[].result, is never lifted into `cards`, and SKILL.md tells the agent
// to report it — so losing it here means the chat path can never report it.
test("toolResultsText surfaces scheduled from approve_feed_item", () => {
  const msgs: PollMessage[] = [
    {
      message_id: 1,
      role: "assistant",
      content: "Approved.",
      actions: [
        {
          tool: "approve_feed_item",
          args: { feed_item_id: 5 },
          result: { message: "Approved", scheduled: 0 },
        },
      ],
    },
  ];
  const out = toolResultsText(msgs);
  assert.match(out, /approve_feed_item/);
  assert.match(out, /scheduled/);
  assert.match(out, /0/);
});

test("toolResultsText ignores link cards — they carry no result", () => {
  const msgs: PollMessage[] = [
    { message_id: 1, role: "assistant", content: "hi", actions: [{ label: "View", url: "https://x", style: "primary" }] },
  ];
  assert.equal(toolResultsText(msgs), "");
});

test("toolResultsText skips tools already surfaced via cards, to avoid double-reporting", () => {
  const msgs: PollMessage[] = [
    {
      message_id: 1,
      role: "assistant",
      content: "See card.",
      actions: [{ tool: "recommend_targeting", result: { advice: "Start on Meta." } }],
      cards: { targeting_advice: { heading: "Your targeting plan", advice: "Start on Meta." } },
    },
  ];
  assert.equal(toolResultsText(msgs), "");
});

// Regression for the 2026-08-23 server fix: metadata[:actions] (symbol, the
// tool-call log) and metadata["actions"] (string, button cards) used to
// serialise to the same jsonb "actions" key, silently discarding the log on
// any turn that also produced buttons. The server now exposes the log under
// its own tool_calls key, with actions[] carrying button cards only.
test("toolResultsText reads the log from tool_calls when present (post-fix rows)", () => {
  const msgs: PollMessage[] = [
    {
      message_id: 1,
      role: "assistant",
      content: "Approved.",
      tool_calls: [
        { tool: "approve_feed_item", args: { feed_item_id: 5 }, result: { message: "Approved", scheduled: 0 } },
      ],
      actions: [{ label: "View", url: "https://x", style: "primary" }],
    },
  ];
  const out = toolResultsText(msgs);
  assert.match(out, /approve_feed_item/);
  assert.match(out, /scheduled/);
  assert.match(out, /0/);
});

test("toolResultsText falls back to actions[] only when tool_calls is absent (historical rows)", () => {
  // tool_calls is undefined here — mirrors a row written before the fix,
  // where the log was mixed into actions[] instead of living on its own key.
  const msgs: PollMessage[] = [
    {
      message_id: 1,
      role: "assistant",
      content: "Approved.",
      actions: [
        { tool: "approve_feed_item", args: { feed_item_id: 5 }, result: { message: "Approved", scheduled: 0 } },
      ],
    },
  ];
  const out = toolResultsText(msgs);
  assert.match(out, /approve_feed_item/);
  assert.match(out, /scheduled/);
});

test("toolResultsText does not double-report when tool_calls is present — actions[] is ignored for that message even if it somehow also carries the same tool", () => {
  const msgs: PollMessage[] = [
    {
      message_id: 1,
      role: "assistant",
      content: "Approved.",
      tool_calls: [
        { tool: "approve_feed_item", args: { feed_item_id: 5 }, result: { message: "Approved", scheduled: 0 } },
      ],
      // Should never happen post-fix (actions[] is buttons-only going forward),
      // but if a row somehow carried the same tool result in both places, it
      // must still surface exactly once.
      actions: [
        { tool: "approve_feed_item", args: { feed_item_id: 5 }, result: { message: "Approved", scheduled: 0 } },
      ],
    },
  ];
  const out = toolResultsText(msgs);
  const occurrences = out.split("approve_feed_item").length - 1;
  assert.equal(occurrences, 1);
});

// Two DISTINCT calls to the same tool with the SAME result payload but
// DIFFERENT args (e.g. two approve_feed_item calls that both happen to
// return scheduled: 0, for two different feed items) must not collapse into
// one reported line — a dedup key that ignores args would hide one of the
// two scheduled counts, defeating the whole point of this function.
test("toolResultsText reports both calls when the same tool returns identical results for different args", () => {
  const msgs: PollMessage[] = [
    {
      message_id: 1,
      role: "assistant",
      content: "Approved both.",
      tool_calls: [
        { tool: "approve_feed_item", args: { feed_item_id: 5 }, result: { message: "Approved", scheduled: 0 } },
        { tool: "approve_feed_item", args: { feed_item_id: 9 }, result: { message: "Approved", scheduled: 0 } },
      ],
    },
  ];
  const out = toolResultsText(msgs);
  const occurrences = out.split("approve_feed_item").length - 1;
  assert.equal(occurrences, 2, `expected both distinct calls reported, got:\n${out}`);
});

// A TRUE duplicate — same tool, same args, same result — must still collapse
// to one reported line (the seen-set's actual job, as opposed to the
// differing-args case above which must NOT collapse).
test("toolResultsText collapses a true duplicate — same tool, same args, same result", () => {
  const msgs: PollMessage[] = [
    {
      message_id: 1,
      role: "assistant",
      content: "Approved.",
      tool_calls: [
        { tool: "approve_feed_item", args: { feed_item_id: 5 }, result: { message: "Approved", scheduled: 0 } },
        { tool: "approve_feed_item", args: { feed_item_id: 5 }, result: { message: "Approved", scheduled: 0 } },
      ],
    },
  ];
  const out = toolResultsText(msgs);
  const occurrences = out.split("approve_feed_item").length - 1;
  assert.equal(occurrences, 1, `expected the true duplicate collapsed to one line, got:\n${out}`);
});

test("toolResultsText handles missing actions without throwing", () => {
  const msgs: PollMessage[] = [{ message_id: 1, role: "assistant", content: "hello" }];
  assert.equal(toolResultsText(msgs), "");
});

// This is the FIX 2 regression case: autowhisper_confirm used to discard the
// response body and always say "Done — the action was performed.", even when
// approving a feed item published to zero platforms. It must say that instead,
// using the exact same wording formatAction already gives the direct-action path.
test("formatConfirmResult reports scheduled: 0 on a 'yes' confirm — nothing went out", () => {
  const out = formatConfirmResult("yes", { message: "Approved", scheduled: 0 });
  assert.match(out, /nothing was scheduled/);
  assert.equal(out, formatAction({ message: "Approved", scheduled: 0 }));
});

test("formatConfirmResult reports scheduled count on a 'yes' confirm — something went out", () => {
  const out = formatConfirmResult("yes", { message: "Approved", scheduled: 2 });
  assert.match(out, /scheduled to 2 platforms/);
});

test("formatConfirmResult says Declined on 'no', ignoring any result body", () => {
  assert.equal(formatConfirmResult("no", { message: "Approved", scheduled: 3 }), "Declined.");
  assert.equal(formatConfirmResult("no", undefined), "Declined.");
});

test("formatConfirmResult falls back gracefully on 'yes' with an absent/unparseable body", () => {
  assert.equal(formatConfirmResult("yes", undefined), "Done — the action was performed.");
  assert.equal(formatConfirmResult("yes", null), "Done — the action was performed.");
});

test("composeReply folds cards into the combined output — regression guard for the index.ts call site", () => {
  const out = composeReply({
    reply: "See below.",
    cards: "## Your targeting plan\n\nStart on Meta.",
    toolResults: "",
    links: "",
    wsNote: "",
  });
  assert.match(out, /See below/);
  assert.match(out, /Your targeting plan/);
  assert.match(out, /Start on Meta/);
});

// ─────────────────────────────────────────────────────────────────────────────
// receipt_text (server-side since 2026-09-13; wired here 2026-09-21)
//
// The server computes this sentence from what actually happened and writes it
// for the OWNER to read. `message` is aimed at the model. Before this, the
// package only read `message`, so an agent could tell the owner something less
// accurate than the dashboard told them about the same action.
// ─────────────────────────────────────────────────────────────────────────────

test("formatAction prefers receipt_text over message", () => {
  const out = formatAction({
    message: "Approved",
    receipt_text: "2 posts queued; the ad was held back — no ad channel connected.",
  });
  assert.match(out, /no ad channel connected/);
  assert.doesNotMatch(out, /^Approved/);
});

test("formatAction still falls back to message when the server sends no receipt_text", () => {
  assert.match(formatAction({ message: "Approved" }), /Approved/);
});

// The language-neutral "did it actually go anywhere" note must survive: it is
// the one fact an English-speaking agent cannot read out of a localized
// sentence, and receipt_text is localized to the owner just like message is.
test("receipt_text does not swallow the scheduled: 0 warning", () => {
  const out = formatAction({ receipt_text: "已批准", scheduled: 0 });
  assert.match(out, /已批准/);
  assert.match(out, /nothing was scheduled/);
});

test("formatConfirmResult goes through the same receipt_text preference", () => {
  const out = formatConfirmResult("yes", { message: "Approved", receipt_text: "Held back — nothing connected." });
  assert.match(out, /Held back/);
});

// ─────────────────────────────────────────────────────────────────────────────
// formatPerformance — GET /api/performance, wired 2026-09-21
// ─────────────────────────────────────────────────────────────────────────────

test("formatPerformance renders funnel layers with their sources", () => {
  const out = formatPerformance({
    workspace_id: 7,
    period: { from: "2026-08-22T00:00:00Z", to: "2026-09-21T00:00:00Z" },
    layers: { published: 12, reached: 800, engaged: 40, inquiries: 3 },
    layer_sources: { reached: "platform analytics" },
    ad_spend_cents: 12345,
  });
  assert.match(out, /workspace 7/);
  assert.match(out, /2026-08-22 → 2026-09-21/);
  assert.match(out, /published: 12/);
  assert.match(out, /reached: 800 \(platform analytics\)/);
  assert.match(out, /Ad spend: \$123\.45/);
});

// ⚠️ The server is explicit that these are different answers: null means it
// cannot tell us (no active workspace), 0 means nothing was spent. Rendering
// null as $0.00 invents a fact about the owner's ad budget.
test("formatPerformance keeps null ad spend distinct from zero", () => {
  assert.match(formatPerformance({ ad_spend_cents: null }), /unknown/);
  assert.match(formatPerformance({ ad_spend_cents: 0 }), /\$0\.00/);
  assert.doesNotMatch(formatPerformance({ ad_spend_cents: null }), /\$0\.00/);
});

// An empty funnel printed as nothing reads as "all zero" — a claim. Say it.
test("formatPerformance says there is no data instead of printing an empty funnel", () => {
  assert.match(formatPerformance({ layers: {} }), /No funnel data/);
});

test("formatPerformance survives an absent body without throwing", () => {
  assert.match(formatPerformance(undefined), /Performance/);
  assert.match(formatPerformance(null), /unknown/);
});

test("formatPerformance breaks out per-channel stats", () => {
  const out = formatPerformance({ by_channel: { instagram: { posts: 4, engagements: 31 } } });
  assert.match(out, /instagram: posts=4, engagements=31/);
});
