import { test } from "node:test";
import assert from "node:assert/strict";
import { fastReadPath } from "./fast-read.js";

// Regression: these all contain a read keyword AND ask for work. The old keyword
// matcher returned a read-only endpoint for each, so the CMO was never called and
// the requested action silently never happened.
const MUST_REACH_CMO = [
  "批准 feed 里的所有内容",
  "帮我发帖到 LinkedIn",
  "把待处理的内容都批准了",
  "generate content for every platform I've connected",
  "approve everything pending in the feed",
  "publish my scheduled posts now",
  "show me products I should promote and make content for them",
  "connect my Instagram platform",
  "make a batch of ad creatives",
  "retry the failed posts",
  "买点积分",
  "给我做几条帖子",
];

// Pure lookups: no work requested, so answering from the fast API is right.
const PURE_LOOKUPS: Array<[string, string]> = [
  ["我有多少产品", "/api/products/summary"],
  ["how many products do I have?", "/api/products/summary"],
  ["列出我的产品", "/api/products"],
  ["余额还有多少", "/api/wallet"],
  ["what's my credit balance?", "/api/wallet"],
  ["已连接哪些平台", "/api/platforms"],
  ["which platforms are connected?", "/api/platforms"],
  ["有多少待处理的", "/api/cmo/feed"],
  ["failed posts?", "/api/posts"],
  ["account status", "/api/cmo/status"],
  // State readings, not actions: 已连接 contains 连接, 发布失败 contains 发布.
  ["已连接了哪些平台", "/api/platforms"],
  ["发布失败的帖子列表", "/api/posts"],
];

test("an instruction that asks for work always reaches the CMO", () => {
  for (const instruction of MUST_REACH_CMO) {
    assert.equal(
      fastReadPath(instruction),
      null,
      `${JSON.stringify(instruction)} requests an action — short-circuiting it to a read silently drops the work`,
    );
  }
});

test("a pure lookup is answered by its fast endpoint", () => {
  for (const [instruction, expected] of PURE_LOOKUPS) {
    assert.equal(fastReadPath(instruction), expected, `${JSON.stringify(instruction)} should route to ${expected}`);
  }
});

test("an unrelated instruction goes to the CMO", () => {
  assert.equal(fastReadPath("which creative should I put money behind?"), null);
  assert.equal(fastReadPath(""), null);
});
