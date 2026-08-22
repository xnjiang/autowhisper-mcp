import { test } from "node:test";
import assert from "node:assert/strict";
import { pollUrl, cardText, type PollMessage } from "./poll-shape.js";

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
