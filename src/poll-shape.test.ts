import { test } from "node:test";
import assert from "node:assert/strict";
import { pollUrl, cardText, toolResultsText, composeReply, type PollMessage } from "./poll-shape.js";

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

test("toolResultsText handles missing actions without throwing", () => {
  const msgs: PollMessage[] = [{ message_id: 1, role: "assistant", content: "hello" }];
  assert.equal(toolResultsText(msgs), "");
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
