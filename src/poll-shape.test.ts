import { test } from "node:test";
import assert from "node:assert/strict";
import { pollUrl } from "./poll-shape.js";

test("pollUrl carries workspace_id — polling is workspace-scoped", () => {
  assert.equal(pollUrl(42, 183), "/api/cmo/messages/42?workspace_id=183");
});

test("pollUrl omits the query when no workspace was given", () => {
  assert.equal(pollUrl(42, undefined), "/api/cmo/messages/42");
});
