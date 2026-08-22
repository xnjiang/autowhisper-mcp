#!/usr/bin/env node
/**
 * AutoWhisper MCP server.
 * Exposes AutoWhisper to any MCP client as a few tools:
 *   - autowhisper_cmo:              send an instruction, wait for the CMO's reply
 *   - autowhisper_products_summary: fast read-only product counts
 *   - autowhisper_products:         fast read-only product list
 *   - autowhisper_status:           fast read-only account/CMO status
 *   - autowhisper_feed:             fast read-only CMO feed list
 *   - autowhisper_posts/wallet/platforms: fast operational reads
 *   - autowhisper_action:           deterministic feed/post actions
 *   - autowhisper_edit_content:     deterministic field-level content edits
 *   - autowhisper_confirm:          approve/decline a high-impact action
 *
 * Auth: set AUTOWHISPER_API_TOKEN (Settings -> Connect your agent).
 * Base: override with AUTOWHISPER_BASE_URL (defaults to https://autowhisper.xyz).
 *
 * NOTE: stdout is the JSON-RPC channel — never write logs there. Use console.error.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fastReadPath } from "./fast-read.js";
import { pollUrl, type PollMessage } from "./poll-shape.js";

const BASE_URL = (process.env.AUTOWHISPER_BASE_URL || "https://autowhisper.xyz").replace(/\/+$/, "");
const TOKEN = process.env.AUTOWHISPER_API_TOKEN || "";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 90000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

async function api(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
}

const NO_TOKEN = `AUTOWHISPER_API_TOKEN is not set. Get a token at ${BASE_URL}/skill (Settings -> Connect your agent — new accounts get free credits), then set it in this MCP server's env.`;

type ProductSummary = {
  account?: {
    workspaces_count?: number;
    active_products_count?: number;
    archived_products_count?: number;
    total_products_count?: number;
  };
  current_workspace?: {
    id?: number;
    name?: string;
    active_products_count?: number;
    archived_products_count?: number;
    total_products_count?: number;
  } | null;
  workspaces?: Array<{
    id?: number;
    name?: string;
    active_products_count?: number;
    archived_products_count?: number;
    total_products_count?: number;
  }>;
};

type ProductList = {
  scope?: string;
  count?: number;
  returned?: number;
  workspace?: { id?: number; name?: string } | null;
  products?: Array<{
    id?: number;
    name?: string;
    product_type?: string;
    workspace_name?: string;
    archived?: boolean;
    detail_link?: string | null;
    has_main_image?: boolean;
  }>;
};

type CmoStatus = {
  current_workspace?: { id?: number; name?: string } | null;
  // ★ 2026-08-09:服务端把读接口收进当前工作区后新增的【目录】。收窄作用域却不给
  // 发现出口 = 调用方被永久锁在第一个工作区,所以这个字段是隔离的必要配套。
  workspaces?: Array<{ id?: number; name?: string; current?: boolean }>;
  account?: { workspaces_count?: number; timezone?: string };
  products?: { active_count?: number; archived_count?: number; total_count?: number };
  feed?: Record<string, number>;
  platforms?: Record<string, number>;
  wallet?: { balance?: number; formatted_balance?: string };
  settings?: Record<string, unknown>;
};

type FeedList = {
  scope?: string;
  status?: string;
  returned?: number;
  counts?: Record<string, number>;
  workspace?: { id?: number; name?: string } | null;
  feed_items?: Array<{
    id?: number;
    action_type?: string;
    priority?: string;
    status?: string;
    recommendation?: string | null;
    created_at?: string;
    feedable?: {
      type?: string;
      id?: number;
      title?: string;
      product_name?: string | null;
      status?: string | null;
      content_status?: string | null;
      cover_image_url?: string | null;
      media_urls?: string[];
      share_url?: string | null;
    } | null;
    available_actions?: Array<{
      tool?: string;
      // The exact arguments to pass to autowhisper_action for this row. Present
      // since the 2026-07-27 API change. It matters most for regenerate_content,
      // whose content_type is the snake_case enum value ("social_copy") while
      // feedable.type is the class name ("SocialCopy") — do not re-derive it.
      args?: Record<string, string | number>;
      confirmation_required?: boolean;
      capabilities?: string[];
    }>;
  }>;
};

type PostList = {
  scope?: string;
  workspace?: { id?: number; name?: string } | null;
  status?: string;
  returned?: number;
  posts?: Array<{
    id?: number;
    status?: string;
    scheduled_at?: string | null;
    published_at?: string | null;
    workspace?: { id?: number; name?: string } | null;
    platform?: { type?: string | null; username?: string | null };
    content?: { type?: string; id?: number; title?: string | null; share_url?: string | null };
    // Present only on failed posts. Without it, [failed] is undiagnosable.
    failure?: { reason?: string | null; needs_reconnect?: boolean; retry_count?: number | null } | null;
  }>;
};

type Wallet = { balance?: number; formatted_balance?: string; currency?: string };

type PlatformList = {
  scope?: string;
  workspace?: { id?: number; name?: string } | null;
  returned?: number;
  platforms?: Array<{
    id?: number;
    workspace?: { id?: number; name?: string } | null;
    type?: string;
    username?: string | null;
    active?: boolean;
    connected?: boolean;
    needs_reconnect?: boolean;
    auto_publishable?: boolean;
    health?: string;
  }>;
};

type ActionResult = {
  confirmation_required?: boolean;
  message_id?: number;
  success?: boolean;
  message?: string;
  error?: string;
  updated_fields?: string[];
  // approve_feed_item: how many platforms the piece was actually scheduled to.
  // 0 means it went nowhere (nothing connected that accepts this content).
  scheduled?: number;
};

// A body is not guaranteed to be JSON: a proxy 502, a redirect, or a Rails error
// page all return HTML. `await res.json()` on those THROWS, which used to escape
// the tool handler as an unhandled rejection instead of a readable message. Always
// read text first and degrade to a snippet.
async function readBody(res: Response): Promise<{ json?: unknown; snippet: string }> {
  let raw = "";
  try {
    raw = await res.text();
  } catch (e) {
    return { snippet: `<unreadable body: ${(e as Error).message}>` };
  }
  try {
    return { json: JSON.parse(raw), snippet: raw.slice(0, 300) };
  } catch {
    return { snippet: raw.slice(0, 300) || "<empty body>" };
  }
}

// Server-supplied `error` strings are the actionable part ("workspace not found",
// "invalid status"). A bare "HTTP 404" tells an agent nothing it can act on.
function apiErrorMessage(res: Response, body: { json?: unknown; snippet: string }): string {
  const fromJson = (body.json as { error?: string } | undefined)?.error;
  if (fromJson) return `AutoWhisper API error (HTTP ${res.status}): ${fromJson}`;
  return `AutoWhisper API error: HTTP ${res.status} — ${body.snippet}`;
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  okStatuses: number[] = [],
): Promise<{ data?: T; error?: string }> {
  let res: Response;
  try {
    res = await api(path, init);
  } catch (e) {
    return { error: `Could not reach AutoWhisper at ${BASE_URL}: ${(e as Error).message}` };
  }
  if (res.status === 401) return { error: "Unauthorized — check your AUTOWHISPER_API_TOKEN." };

  const body = await readBody(res);
  if (!res.ok && !okStatuses.includes(res.status)) return { error: apiErrorMessage(res, body) };
  if (body.json === undefined) {
    return { error: `AutoWhisper returned a non-JSON response (HTTP ${res.status}): ${body.snippet}` };
  }
  return { data: body.json as T };
}

async function getJson<T>(path: string): Promise<{ data?: T; error?: string }> {
  return requestJson<T>(path, { method: "GET" });
}

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

async function postForm<T>(path: string, values: Record<string, string>): Promise<{ data?: T; error?: string }> {
  // 202 carries the confirmation_required payload, so it is a success here.
  return requestJson<T>(path, { method: "POST", headers: FORM_HEADERS, body: new URLSearchParams(values) }, [202]);
}

async function patchForm<T>(path: string, values: Record<string, string>): Promise<{ data?: T; error?: string }> {
  return requestJson<T>(path, { method: "PATCH", headers: FORM_HEADERS, body: new URLSearchParams(values) });
}

function formatProductSummary(summary: ProductSummary): string {
  const account = summary.account || {};
  const lines = [
    `Products: ${account.active_products_count ?? 0} active, ${account.archived_products_count ?? 0} archived, ${account.total_products_count ?? 0} total.`,
    `Workspaces: ${account.workspaces_count ?? 0}.`,
  ];
  const workspaceLines = (summary.workspaces || []).map(
    (w) =>
      `- ${w.name || `Workspace ${w.id}`}: ${w.active_products_count ?? 0} active, ${w.archived_products_count ?? 0} archived, ${w.total_products_count ?? 0} total`,
  );
  return [lines.join("\n"), workspaceLines.length ? `By workspace:\n${workspaceLines.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

function formatProductList(list: ProductList): string {
  const products = list.products || [];
  const rows = products.map((p) => {
    const archived = p.archived ? " archived" : "";
    const image = p.has_main_image ? " image" : " no image";
    const workspace = p.workspace_name ? ` @ ${p.workspace_name}` : "";
    const link = p.detail_link ? ` ${p.detail_link}` : "";
    return `- #${p.id} ${p.name || "Untitled"} (${p.product_type || "product"}${archived};${image}${workspace})${link}`;
  });
  return [`Products returned: ${list.returned ?? products.length}/${list.count ?? products.length}`, rows.join("\n")].filter(Boolean).join("\n\n");
}

function formatCmoStatus(status: CmoStatus): string {
  const feed = status.feed || {};
  const platforms = status.platforms || {};
  const products = status.products || {};
  const wallet = status.wallet || {};
  const cur = status.current_workspace;
  const all = status.workspaces || [];
  // 每一行计数都【只属于当前工作区】—— 不说清楚的话,调用方会把它当成账号总数,
  // 而账号总数在 autowhisper_products_summary 里(那个才跨全部工作区)。
  const header = cur?.name
    ? `Current workspace: ${cur.name} (id ${cur.id}). All counts below are for THIS workspace only.`
    : "Current workspace: unknown.";
  const directory = all.length > 1
    ? `Other workspaces (pass workspace_id to read them): ${all.filter((w) => !w.current).map((w) => `${w.name} (id ${w.id})`).join(", ")}.`
    : "";
  return [
    header,
    directory,
    `Products: ${products.active_count ?? 0} active, ${products.archived_count ?? 0} archived, ${products.total_count ?? 0} total.`,
    `Feed: ${feed.pending ?? 0} pending, ${feed.approved ?? 0} approved, ${feed.executed ?? 0} executed.`,
    `Platforms: ${platforms.connected_count ?? 0} connected, ${platforms.needs_reconnect_count ?? 0} need reconnect, ${platforms.auto_publishable_count ?? 0} auto-publishable.`,
    `Wallet: ${wallet.formatted_balance || `${wallet.balance ?? 0} tokens`} (account-wide, not per workspace).`,
  ].filter(Boolean).join("\n");
}

// The feed reports feedable.type as a Rails class name ("SocialCopy"), but every
// content-addressing tool takes snake_case ("social_copy"). Emitting the raw class
// name left agents to guess the mapping, so print the value the tools accept.
function snakeCaseType(type: string | undefined): string {
  if (!type) return "content";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function formatFeed(list: FeedList): string {
  const counts = list.counts || {};
  const items = list.feed_items || [];
  // Two DIFFERENT id spaces live on one row and must never be shown as one bare
  // "#795": feed_item_id addresses the review card (approve/reject/dismiss) while
  // content_id addresses the content itself (edit_content). Printing only the feed
  // item id made agents pass it as content_id and get "not found" — reported
  // 2026-07-23 as an edit_content bug. Always label which id is which.
  const rows = items.map((item) => {
    const f = item.feedable || {};
    const product = f.product_name ? ` · ${f.product_name}` : "";
    // Print each action WITH its arguments. Listing bare tool names made the
    // agent guess which id went where — the same mistake the content_id label
    // below was added to prevent (2026-07-23). The server already computed the
    // right call; passing it through costs nothing and removes the guess.
    const actions = (item.available_actions || [])
      .map((a) => {
        const args = a.args
          ? `(${Object.entries(a.args).map(([k, v]) => `${k}=${v}`).join(" ")})`
          : "";
        return `${a.tool}${args}${a.confirmation_required ? " [confirm]" : ""}`;
      })
      .join(", ");
    const contentRef = f.id ? ` · content: ${snakeCaseType(f.type)} #${f.id}` : "";
    const title = f.title || item.action_type || "Feed item";
    return `- feed_item #${item.id}${contentRef} — ${title} [${item.status || "unknown"}${product}]${actions ? ` actions: ${actions}` : ""}`;
  });
  const header = `Feed (${list.status || "pending"}): ${items.length}/${list.returned ?? items.length} returned. Counts: pending ${counts.pending ?? 0}, approved ${counts.approved ?? 0}, rejected ${counts.rejected ?? 0}, executed ${counts.executed ?? 0}.`;
  return [header, rows.join("\n")].filter(Boolean).join("\n\n");
}

// ★ 2026-08-09:服务端把 feed / posts / platforms / products 从"不传 workspace_id
// 就跨全部工作区"改成了"不传就用当前工作区" ⇒ 这些列表【永远】是单工作区的,
// scope 恒为 "workspace"。每行仍标出工作区名:调用方得看得出自己拿到的是哪个
// 工作区的数据,而且两个客户端相同的 @handle 否则分不清。
// ("account" 分支留着只为兼容还没升级的服务端。)
function scopeLine(scope: string | undefined, workspace: { name?: string } | null | undefined): string {
  if (scope === "workspace" && workspace?.name) return ` (workspace: ${workspace.name})`;
  return scope === "account" ? " (all workspaces)" : "";
}

function workspaceTag(workspace: { name?: string } | null | undefined): string {
  return workspace?.name ? ` [${workspace.name}]` : "";
}

function formatPosts(list: PostList): string {
  const posts = list.posts || [];
  const rows = posts.map((post) => {
    const content = post.content || {};
    const platform = post.platform?.type || "unknown platform";
    const when = post.scheduled_at ? ` at ${post.scheduled_at}` : "";
    // A failed row is only useful with its reason and whether a retry can work:
    // needs_reconnect means the human must re-authorise, so retry_post never helps.
    const f = post.failure;
    const failure = f
      ? ` — failed: ${f.reason || "no reason reported"}${f.needs_reconnect ? " (needs reconnect: a human must re-authorise this channel; retry will not help)" : " (retryable with autowhisper_action retry_post)"}`
      : "";
    const contentRef = content.id ? ` · content: ${snakeCaseType(content.type)} #${content.id}` : "";
    return `- post #${post.id}${contentRef} ${content.title || "content"} -> ${platform} [${post.status || "unknown"}]${when}${workspaceTag(post.workspace)}${failure}`;
  });
  const header = `Posts: ${posts.length}/${list.returned ?? posts.length} returned${scopeLine(list.scope, list.workspace)}.`;
  return [header, rows.join("\n")].filter(Boolean).join("\n\n");
}

function formatPlatforms(list: PlatformList): string {
  const platforms = list.platforms || [];
  const rows = platforms.map((platform) => {
    const handle = platform.username ? ` @${platform.username}` : "";
    const state = platform.needs_reconnect ? "needs reconnect" : platform.connected ? "connected" : "not connected";
    return `- #${platform.id} ${platform.type || "platform"}${handle}: ${state}${platform.auto_publishable ? "; auto-publishable" : ""}${workspaceTag(platform.workspace)}`;
  });
  const header = `Platforms: ${platforms.length}/${list.returned ?? platforms.length} returned${scopeLine(list.scope, list.workspace)}.`;
  return [header, rows.join("\n")].filter(Boolean).join("\n\n");
}

function formatAction(result: ActionResult): string {
  if (result.confirmation_required) {
    return `[Confirmation required] Call autowhisper_confirm with message_id=${result.message_id} and decision="yes" to proceed, or "no" to decline.`;
  }
  const message = result.message || "Done.";
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

async function handleFastRead(path: string) {
  if (path === "/api/products/summary") {
    const result = await getJson<ProductSummary>(path);
    return result.error ? text(result.error, true) : text(formatProductSummary(result.data || {}));
  }
  if (path === "/api/products") {
    const result = await getJson<ProductList>(path);
    return result.error ? text(result.error, true) : text(formatProductList(result.data || {}));
  }
  if (path === "/api/cmo/feed") {
    const result = await getJson<FeedList>(path);
    return result.error ? text(result.error, true) : text(formatFeed(result.data || {}));
  }
  if (path === "/api/posts") {
    const result = await getJson<PostList>(path);
    return result.error ? text(result.error, true) : text(formatPosts(result.data || {}));
  }
  if (path === "/api/wallet") {
    const result = await getJson<Wallet>(path);
    const wallet = result.data || {};
    return result.error ? text(result.error, true) : text(`Wallet: ${wallet.formatted_balance || `${wallet.balance ?? 0} ${wallet.currency || "credits"}`}.`);
  }
  if (path === "/api/platforms") {
    const result = await getJson<PlatformList>(path);
    return result.error ? text(result.error, true) : text(formatPlatforms(result.data || {}));
  }
  const result = await getJson<CmoStatus>(path);
  return result.error ? text(result.error, true) : text(formatCmoStatus(result.data || {}));
}

const server = new McpServer({ name: "autowhisper", version: "0.5.0" });

server.registerTool(
  "autowhisper_products_summary",
  {
    title: "AutoWhisper product counts",
    description: "Fast read-only product counts, account-wide AND per workspace. Unlike the other read tools this one spans EVERY workspace — use it for 'how many products do I have in total?' and to discover workspace ids.",
    inputSchema: {},
  },
  async () => {
    if (!TOKEN) return text(NO_TOKEN, true);
    return handleFastRead("/api/products/summary");
  },
);

server.registerTool(
  "autowhisper_products",
  {
    title: "AutoWhisper products",
    description: "Fast read-only product list for ONE workspace (the user's current one unless workspace_id is given). Use instead of autowhisper_cmo when the user only wants to list/search products.",
    inputSchema: {
      include_archived: z.boolean().optional().describe("Include archived products."),
      workspace_id: z.number().optional().describe("Workspace to read. Omit for the user's CURRENT workspace — other workspaces are NOT included. To reach another one, get its id from autowhisper_status."),
      limit: z.number().optional().describe("Maximum products to return, capped by the API."),
    },
  },
  async ({ include_archived, workspace_id, limit }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const params = new URLSearchParams();
    if (include_archived !== undefined) params.set("include_archived", String(include_archived));
    if (workspace_id !== undefined) params.set("workspace_id", String(workspace_id));
    if (limit !== undefined) params.set("limit", String(limit));
    const path = `/api/products${params.size ? `?${params.toString()}` : ""}`;
    const result = await getJson<ProductList>(path);
    return result.error ? text(result.error, true) : text(formatProductList(result.data || {}));
  },
);

server.registerTool(
  "autowhisper_status",
  {
    title: "AutoWhisper CMO status",
    description: "Fast read-only CMO snapshot for the user's CURRENT workspace (products, feed, platforms, automation settings) plus the account-level wallet and a directory of EVERY workspace with its id. Call this first to learn which workspaces exist and which one is current — every other read tool defaults to the current one and does NOT span the others.",
    inputSchema: {},
  },
  async () => {
    if (!TOKEN) return text(NO_TOKEN, true);
    return handleFastRead("/api/cmo/status");
  },
);

server.registerTool(
  "autowhisper_feed",
  {
    title: "AutoWhisper CMO feed",
    description: "Fast read-only CMO feed list for ONE workspace (the user's current one unless workspace_id is given), with status counts and available actions. Use for pending review/feed/status questions.",
    inputSchema: {
      status: z.enum(["pending", "approved", "rejected", "dismissed", "executed", "all"]).optional().describe("Feed status to return. Defaults to pending."),
      workspace_id: z.number().optional().describe("Workspace to read. Omit for the user's CURRENT workspace — other workspaces are NOT included. To reach another one, get its id from autowhisper_status."),
      limit: z.number().optional().describe("Maximum feed items to return, capped by the API."),
    },
  },
  async ({ status, workspace_id, limit }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const params = new URLSearchParams();
    if (status !== undefined) params.set("status", status);
    if (workspace_id !== undefined) params.set("workspace_id", String(workspace_id));
    if (limit !== undefined) params.set("limit", String(limit));
    const path = `/api/cmo/feed${params.size ? `?${params.toString()}` : ""}`;
    const result = await getJson<FeedList>(path);
    return result.error ? text(result.error, true) : text(formatFeed(result.data || {}));
  },
);

server.registerTool(
  "autowhisper_posts",
  {
    title: "AutoWhisper posts",
    description: "Fast delivery-queue list for ONE workspace (the user's current one unless workspace_id is given). Use for scheduled, failed, and published post facts.",
    inputSchema: {
      status: z.enum(["draft", "scheduled", "publishing", "published", "failed"]).optional().describe("Optional post status filter."),
      workspace_id: z.number().optional().describe("Workspace to read. Omit for the user's CURRENT workspace — other workspaces are NOT included. To reach another one, get its id from autowhisper_status."),
      limit: z.number().optional().describe("Maximum posts to return, capped by the API."),
    },
  },
  async ({ status, workspace_id, limit }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const params = new URLSearchParams();
    if (status !== undefined) params.set("status", status);
    if (workspace_id !== undefined) params.set("workspace_id", String(workspace_id));
    if (limit !== undefined) params.set("limit", String(limit));
    const path = `/api/posts${params.size ? `?${params.toString()}` : ""}`;
    const result = await getJson<PostList>(path);
    return result.error ? text(result.error, true) : text(formatPosts(result.data || {}));
  },
);

server.registerTool(
  "autowhisper_wallet",
  {
    title: "AutoWhisper wallet",
    description: "Fast read-only credit balance. Use before proposing or starting credit-spending generation.",
    inputSchema: {},
  },
  async () => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const result = await getJson<Wallet>("/api/wallet");
    const wallet = result.data || {};
    return result.error ? text(result.error, true) : text(`Wallet: ${wallet.formatted_balance || `${wallet.balance ?? 0} ${wallet.currency || "credits"}`}.`);
  },
);

server.registerTool(
  "autowhisper_platforms",
  {
    title: "AutoWhisper platforms",
    description: "Fast read-only connected-platform list and connection health for ONE workspace (the user's current one unless workspace_id is given).",
    inputSchema: { workspace_id: z.number().optional().describe("Workspace to read. Omit for the user's CURRENT workspace — other workspaces are NOT included. To reach another one, get its id from autowhisper_status.") },
  },
  async ({ workspace_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const path = `/api/platforms${workspace_id !== undefined ? `?workspace_id=${workspace_id}` : ""}`;
    const result = await getJson<PlatformList>(path);
    return result.error ? text(result.error, true) : text(formatPlatforms(result.data || {}));
  },
);

server.registerTool(
  "autowhisper_action",
  {
    title: "AutoWhisper delivery action",
    description: "Run an explicit feed or post action without an AI chat turn. High-impact actions return a confirmation message_id; confirm it with autowhisper_confirm. approve_feed_item PUBLISHES: it schedules the piece to every connected platform, and for a video draft it also starts the render and charges credits for it — approving is the spend, not a bookmark. When nothing is connected it schedules nothing, and connecting a platform later does NOT go back for it; the result line says which happened. regenerate_content rewrites an existing draft IN PLACE (same record id, new text) — it is the same action as the Revise button on the web feed card; it takes content_type + content_id, not feed_item_id, and always returns a confirmation because it spends credits.",
    inputSchema: {
      tool: z.enum(["approve_feed_item", "reject_feed_item", "dismiss_feed_item", "publish_content", "regenerate_content", "reschedule_post", "retry_post", "mark_as_published"]),
      feed_item_id: z.number().optional().describe("Required for feed actions. The leading `feed_item #<id>` in an autowhisper_feed row — NOT the `content: <type> #<id>` on the same row."),
      post_id: z.number().optional().describe("Required for post actions."),
      scheduled_at: z.string().optional().describe("Required for reschedule_post; ISO8601 or natural language supported by AutoWhisper."),
      reason: z.string().optional().describe("Optional reason for rejecting a feed item."),
      content_type: z.enum(["social_copy", "lookbook", "feature_poster", "idea"]).optional().describe("Required for regenerate_content. The snake_case value from the row's `content: <type> #<id>` — NOT the class name."),
      content_id: z.number().optional().describe("Required for regenerate_content. The id from the row's `content: <type> #<id>` — NOT feed_item_id."),
      workspace_id: z.number().optional().describe("Workspace to act in. Omit for the user's CURRENT workspace. The target item must live in that workspace — an id from another workspace will not be found."),
    },
  },
  async ({ tool, feed_item_id, post_id, scheduled_at, reason, content_type, content_id, workspace_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const values: Record<string, string> = {};
    if (feed_item_id !== undefined) values.feed_item_id = String(feed_item_id);
    if (post_id !== undefined) values.post_id = String(post_id);
    if (scheduled_at !== undefined) values.scheduled_at = scheduled_at;
    if (reason !== undefined) values.reason = reason;
    if (content_type !== undefined) values.content_type = content_type;
    if (content_id !== undefined) values.content_id = String(content_id);
    if (workspace_id !== undefined) values.workspace_id = String(workspace_id);
    const result = await postForm<ActionResult>(`/api/cmo/actions/${tool}`, values);
    return result.error ? text(result.error, true) : text(formatAction(result.data || {}));
  },
);

server.registerTool(
  "autowhisper_edit_content",
  {
    title: "AutoWhisper edit content",
    description:
      "Directly update exact content fields without a generation run or credit spend. Pass body for the full replacement copy/story. IDs: content_id is the CONTENT id — in autowhisper_feed output that is the `content: <type> #<id>` part of a row, NOT the leading `feed_item #<id>` (that one belongs to autowhisper_action). content_type is the same snake_case value shown there.",
    inputSchema: {
      content_type: z.enum(["social_copy", "lookbook", "feature_poster", "idea"])
        .describe("Content type in snake_case, as printed in the feed row's `content:` part."),
      content_id: z.number()
        .describe("The CONTENT id from the feed row's `content: <type> #<id>` — not the feed_item id."),
      title: z.string().optional(),
      body: z.string().optional(),
      hook: z.string().optional(),
      cta: z.string().optional(),
      tone: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      workspace_id: z.number().optional(),
    },
  },
  async ({ content_type, content_id, title, body, hook, cta, tone, keywords, workspace_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const values: Record<string, string> = {};
    if (title !== undefined) values.title = title;
    if (body !== undefined) values.body = body;
    if (hook !== undefined) values.hook = hook;
    if (cta !== undefined) values.cta = cta;
    if (tone !== undefined) values.tone = tone;
    if (keywords !== undefined) values.keywords = keywords.join(",");
    if (workspace_id !== undefined) values.workspace_id = String(workspace_id);
    const result = await patchForm<ActionResult>(`/api/cmo/content/${content_type}/${content_id}`, values);
    return result.error ? text(result.error, true) : text(formatAction(result.data || {}));
  },
);

server.registerTool(
  "autowhisper_cmo",
  {
    title: "Talk to your AutoWhisper CMO",
    description:
      "Send a natural-language instruction to your AutoWhisper AI CMO and get its reply. Best at: (1) generating batches of on-brand ad creatives (UGC video, posts, images) for paid campaigns, (2) advising which creative to fund and how to target, (3) keeping every social channel alive across 30+ networks, plus analytics. Examples: \"Make a batch of ad creatives for my product https://mystore.com/widget\", \"Which creative should I run first, and how should I target?\", \"Keep my channels posted this week\". Honest scope: posting ≠ traffic — reach comes from the user's paid ads. To add a product, pass a product URL (the CMO extracts the image from the page) — a text-only description will not create it, and placeholder/stock images are rejected.",
    inputSchema: {
      instruction: z.string().describe("What you want the CMO to do, in natural language."),
      product_id: z.string().optional().describe("Optional: act on a specific product by its id."),
      workspace_id: z
        .number()
        .optional()
        .describe(
          "Workspace to act in. Omitting it uses the account's FIRST active workspace, which may not be the one you were just reading — and the workspace decides the generated content's LANGUAGE. Pass the workspace_id shown by autowhisper_feed / autowhisper_platforms / autowhisper_products whenever you are working on a specific one.",
        ),
    },
  },
  async ({ instruction, product_id, workspace_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    if (!product_id) {
      const path = fastReadPath(instruction);
      if (path) return handleFastRead(path);
    }

    // 1. send the instruction. workspace_id must be forwarded: without it the API
    // falls back to workspaces.active.first, so an agent that had just read
    // workspace 3's feed would silently generate into workspace 1 — in workspace
    // 1's content language. This tool used to accept no workspace_id at all.
    const body = new URLSearchParams({ message: instruction });
    if (product_id) body.set("product_id", product_id);
    if (workspace_id !== undefined) body.set("workspace_id", String(workspace_id));
    let send: Response;
    try {
      send = await api("/api/cmo/message", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (e) {
      return text(`Could not reach AutoWhisper at ${BASE_URL}: ${(e as Error).message}`, true);
    }
    if (send.status === 401) return text("Unauthorized — check your AUTOWHISPER_API_TOKEN.", true);
    if (send.status === 429) return text("Rate limited — wait a minute and try again.", true);
    if (!send.ok) return text(`AutoWhisper API error (message): HTTP ${send.status}`, true);
    const sent = (await send.json()) as {
      message_id?: number;
      workspace?: { id?: number; name?: string; content_lang?: string } | null;
    };
    const mid = sent.message_id;
    if (!mid) return text("AutoWhisper returned no message_id.", true);
    // Report the workspace the turn actually resolved to, and its content language.
    // Generated content uses THAT language, never the chat's — so an agent talking
    // in Chinese to an English workspace should expect English content back.
    const ws = sent.workspace;
    const wsNote = ws?.id
      ? `Ran in workspace "${ws.name}" (#${ws.id}); content language: ${ws.content_lang || "unknown"}.`
      : "";

    // 2. poll until the CMO finishes the turn
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let pr: Response;
      try {
        pr = await api(pollUrl(mid, workspace_id), { method: "GET" });
      } catch {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (pr.ok) {
        const p = (await pr.json()) as { done?: boolean; error?: string | null; messages?: PollMessage[] };
        if (p.done) {
          if (p.error) return text(String(p.error), true);
          const msgs = p.messages || [];
          const reply = msgs.map((m) => m.content).filter(Boolean).join("\n\n");
          // Surface action-card URLs (content media links etc.) — the CMO puts
          // these in cards, not in the reply text, so lift them out for the agent.
          const links = msgs
            .flatMap((m) => m.actions || [])
            .filter((a) => Boolean(a && a.url))
            .map((a) => `- ${a.label || "link"}: ${a.url}`);
          const linksText = links.length ? `Media links:\n${links.join("\n")}` : "";
          const combined = [reply, linksText, wsNote].filter(Boolean).join("\n\n");
          const confirm = msgs.find((m) => m.message_kind === "confirm_required" && m.pending_action);
          if (confirm) {
            return text(
              `${combined}\n\n[Confirmation required] The CMO wants to run "${confirm.pending_action?.tool}". To proceed, call autowhisper_confirm with message_id=${confirm.message_id} and decision="yes" (or "no" to decline).`,
            );
          }
          return text(combined || "(the CMO returned no text)");
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return text(
      `The CMO is still working (message_id ${mid}). Media generation runs in the background and lands in your AutoWhisper feed — check there, or ask again shortly.`,
    );
  },
);

server.registerTool(
  "autowhisper_confirm",
  {
    title: "Confirm an AutoWhisper action",
    description:
      "Approve or decline a high-impact action the CMO or autowhisper_action asked you to confirm. Pass the message_id it gave you and decision \"yes\" or \"no\".",
    inputSchema: {
      message_id: z.number().describe("The message_id from the confirmation request."),
      decision: z.enum(["yes", "no"]).describe("\"yes\" to perform the action, \"no\" to decline."),
      workspace_id: z
        .number()
        .optional()
        .describe(
          "The workspace the confirmation lives in — pass the SAME one you used for autowhisper_cmo. Omitting it falls back to the account's first active workspace and 404s on a bubble that lives anywhere else.",
        ),
    },
  },
  async ({ message_id, decision, workspace_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const body = new URLSearchParams({ message_id: String(message_id), decision });
    if (workspace_id !== undefined) body.set("workspace_id", String(workspace_id));
    let res: Response;
    try {
      res = await api("/api/cmo/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (e) {
      return text(`Could not reach AutoWhisper: ${(e as Error).message}`, true);
    }
    if (res.status === 410) return text("This action was already resolved.", true);
    if (res.status === 404)
      return text(
        "Confirmation not found — if you passed a workspace_id to autowhisper_cmo, pass the same one here.",
        true,
      );
    if (res.status === 422) return text("Not a valid confirmation, or invalid decision.", true);
    if (res.status === 401) return text("Unauthorized — check your AUTOWHISPER_API_TOKEN.", true);
    if (!res.ok) return text(`AutoWhisper API error (confirm): HTTP ${res.status}`, true);
    return text(decision === "yes" ? "Done — the action was performed." : "Declined.");
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`autowhisper-mcp ready (base: ${BASE_URL}, token: ${TOKEN ? "set" : "MISSING"})`);
}

main().catch((err) => {
  console.error("autowhisper-mcp fatal:", err);
  process.exit(1);
});
