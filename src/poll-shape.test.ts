import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pollUrl,
  cardText,
  toolResultsText,
  composeReply,
  formatAction,
  formatConfirmResult,
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
