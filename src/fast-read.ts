/**
 * Routing for autowhisper_cmo: decide whether an instruction is a pure lookup that
 * can be answered by a fast read-only endpoint instead of a billed CMO chat turn.
 *
 * Extracted so it can be unit-tested — the old inline version silently turned
 * requested WORK into a read. Its keyword lists contained action words: `批准`
 * (approve), `发帖` (publish), and a bare `platforms?`, so "批准 feed 里的内容",
 * "帮我发帖到 LinkedIn", and "generate content for every platform I've connected"
 * all returned a list and never reached the CMO. The caller saw a plausible
 * response and reported success for work that never happened.
 */

// An instruction containing any of these is asking for something to be DONE. Even
// if it also mentions "products" or "feed", it must reach the CMO. Kept broad on
// purpose: wrongly spending a chat turn on a lookup is cheap, wrongly dropping a
// mutation is not.
//
// The Chinese verbs need care because a state word contains the action word:
// 已连接 ("already connected") contains 连接 ("connect"), and 已发布 contains 发布.
// Lookbehinds exclude the state readings so "已连接哪些平台" stays a lookup.
const ACTION_INTENT =
  /\b(?:generate|create|make|build|write|draft|produce|start|kick\s*off|run|execute|launch|rewrite|regenerate|refine|approve|reject|dismiss|publish|post|schedule|reschedule|retry|connect|disconnect|add|edit|update|delete|archive|buy|top\s*up|go\s+ahead|proceed)\b|生成|创建|制作|做个|做一|帮我做|写一|写个|帮我写|来一|来个|再来|搞个|弄个|开始|启动|运行|执行|重写|改写|批准|通过|拒绝|忽略|(?<![已未没])发布(?!失败)|发帖|去发|排期|重排|重试|(?<![已未没])连接|绑定|解绑|添加|新增|编辑|修改|更新|删除|归档|充值|购买/i;

const RULES: Array<{ path: string; test: (raw: string, lower: string) => boolean }> = [
  {
    path: "/api/products/summary",
    test: (raw, lower) =>
      /多少.*产品|几个.*产品|产品.*数量/.test(raw) ||
      /how many .*products?|product count|number of products/.test(lower),
  },
  {
    path: "/api/products",
    test: (raw, lower) =>
      /列出.*产品|有哪些.*产品|所有产品/.test(raw) || /list .*products?|show .*products?/.test(lower),
  },
  {
    path: "/api/wallet",
    // `credits?` only with a balance-ish word — "ad creatives" and "buy credits"
    // must not both land here.
    test: (raw, lower) => /余额|还有多少积分|积分余额/.test(raw) || /\b(?:wallet|credit balance|how many credits|balance)\b/.test(lower),
  },
  {
    path: "/api/posts",
    test: (raw, lower) =>
      /排期情况|已发布的|发布失败|失败的帖子|帖子列表/.test(raw) ||
      /list .*posts?|scheduled posts?|failed posts?|published posts?|delivery queue/.test(lower),
  },
  {
    path: "/api/platforms",
    // Never a bare "platform": that word appears in most publishing requests.
    test: (raw, lower) =>
      /已连接.*平台|连接了哪些平台|平台列表|哪些平台/.test(raw) ||
      /connected platforms?|list .*platforms?|which platforms?/.test(lower),
  },
  {
    path: "/api/cmo/status",
    test: (raw, lower) => /账号状态|整体概况|当前状态/.test(raw) || /cmo status|account status|overall status/.test(lower),
  },
  {
    path: "/api/cmo/feed",
    // `批准`/`approve` deliberately absent — approving is an action, not a read.
    test: (raw, lower) =>
      /待处理|待审批|待审核|待确认/.test(raw) || /\bfeed\b|pending (?:review|items|content)/.test(lower),
  },
];

/**
 * Returns a fast read-only endpoint for a pure lookup, or null when the
 * instruction should go to the CMO. Anything that asks for work returns null.
 */
export function fastReadPath(instruction: string): string | null {
  const raw = instruction ?? "";
  if (ACTION_INTENT.test(raw)) return null;

  const lower = raw.toLowerCase();
  return RULES.find((rule) => rule.test(raw, lower))?.path ?? null;
}
