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
    available_actions?: Array<{ tool?: string; confirmation_required?: boolean; capabilities?: string[] }>;
  }>;
};

type PostList = {
  workspace?: { id?: number; name?: string } | null;
  status?: string;
  returned?: number;
  posts?: Array<{
    id?: number;
    status?: string;
    scheduled_at?: string | null;
    published_at?: string | null;
    platform?: { type?: string | null; username?: string | null };
    content?: { type?: string; id?: number; title?: string | null; share_url?: string | null };
  }>;
};

type Wallet = { balance?: number; formatted_balance?: string; currency?: string };

type PlatformList = {
  workspace?: { id?: number; name?: string } | null;
  returned?: number;
  platforms?: Array<{
    id?: number;
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
};

async function getJson<T>(path: string): Promise<{ data?: T; error?: string }> {
  let res: Response;
  try {
    res = await api(path, { method: "GET" });
  } catch (e) {
    return { error: `Could not reach AutoWhisper at ${BASE_URL}: ${(e as Error).message}` };
  }
  if (res.status === 401) return { error: "Unauthorized — check your AUTOWHISPER_API_TOKEN." };
  if (!res.ok) return { error: `AutoWhisper API error: HTTP ${res.status}` };
  return { data: (await res.json()) as T };
}

async function postForm<T>(path: string, values: Record<string, string>): Promise<{ data?: T; error?: string }> {
  let res: Response;
  try {
    res = await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
    });
  } catch (e) {
    return { error: `Could not reach AutoWhisper at ${BASE_URL}: ${(e as Error).message}` };
  }
  if (res.status === 401) return { error: "Unauthorized — check your AUTOWHISPER_API_TOKEN." };
  const data = (await res.json()) as T;
  if (!res.ok && res.status !== 202) return { error: (data as { error?: string }).error || `AutoWhisper API error: HTTP ${res.status}` };
  return { data };
}

async function patchForm<T>(path: string, values: Record<string, string>): Promise<{ data?: T; error?: string }> {
  let res: Response;
  try {
    res = await api(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
    });
  } catch (e) {
    return { error: `Could not reach AutoWhisper at ${BASE_URL}: ${(e as Error).message}` };
  }
  if (res.status === 401) return { error: "Unauthorized — check your AUTOWHISPER_API_TOKEN." };
  const data = (await res.json()) as T;
  if (!res.ok) return { error: (data as { error?: string }).error || `AutoWhisper API error: HTTP ${res.status}` };
  return { data };
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
  return [
    `Products: ${products.active_count ?? 0} active, ${products.archived_count ?? 0} archived, ${products.total_count ?? 0} total.`,
    `Feed: ${feed.pending ?? 0} pending, ${feed.approved ?? 0} approved, ${feed.executed ?? 0} executed.`,
    `Platforms: ${platforms.connected_count ?? 0} connected, ${platforms.needs_reconnect_count ?? 0} need reconnect, ${platforms.auto_publishable_count ?? 0} auto-publishable.`,
    `Wallet: ${wallet.formatted_balance || `${wallet.balance ?? 0} tokens`}.`,
  ].join("\n");
}

function formatFeed(list: FeedList): string {
  const counts = list.counts || {};
  const items = list.feed_items || [];
  const rows = items.map((item) => {
    const f = item.feedable || {};
    const product = f.product_name ? ` · ${f.product_name}` : "";
    const actions = (item.available_actions || [])
      .map((a) => `${a.tool}${a.confirmation_required ? " (confirm)" : ""}`)
      .join(", ");
    return `- #${item.id} ${f.title || item.action_type || "Feed item"} [${item.status || "unknown"}${product}]${actions ? ` actions: ${actions}` : ""}`;
  });
  const header = `Feed (${list.status || "pending"}): ${items.length}/${list.returned ?? items.length} returned. Counts: pending ${counts.pending ?? 0}, approved ${counts.approved ?? 0}, rejected ${counts.rejected ?? 0}, executed ${counts.executed ?? 0}.`;
  return [header, rows.join("\n")].filter(Boolean).join("\n\n");
}

function formatPosts(list: PostList): string {
  const posts = list.posts || [];
  const rows = posts.map((post) => {
    const content = post.content || {};
    const platform = post.platform?.type || "unknown platform";
    const when = post.scheduled_at ? ` at ${post.scheduled_at}` : "";
    return `- #${post.id} ${content.title || content.type || "content"} -> ${platform} [${post.status || "unknown"}]${when}`;
  });
  return [`Posts: ${posts.length}/${list.returned ?? posts.length} returned.`, rows.join("\n")].filter(Boolean).join("\n\n");
}

function formatPlatforms(list: PlatformList): string {
  const platforms = list.platforms || [];
  const rows = platforms.map((platform) => {
    const handle = platform.username ? ` @${platform.username}` : "";
    const state = platform.needs_reconnect ? "needs reconnect" : platform.connected ? "connected" : "not connected";
    return `- #${platform.id} ${platform.type || "platform"}${handle}: ${state}${platform.auto_publishable ? "; auto-publishable" : ""}`;
  });
  return [`Platforms: ${platforms.length}/${list.returned ?? platforms.length} returned.`, rows.join("\n")].filter(Boolean).join("\n\n");
}

function formatAction(result: ActionResult): string {
  if (result.confirmation_required) {
    return `[Confirmation required] Call autowhisper_confirm with message_id=${result.message_id} and decision="yes" to proceed, or "no" to decline.`;
  }
  return result.message || "Done.";
}

function fastReadPath(instruction: string): string | null {
  const normalized = instruction.toLowerCase();
  if (
    /多少.*产品/.test(instruction) ||
    /几个.*产品/.test(instruction) ||
    /产品.*数量/.test(instruction) ||
    /how many .*products?/.test(normalized) ||
    /product count|number of products/.test(normalized)
  ) {
    return "/api/products/summary";
  }
  if (
    /列出.*产品/.test(instruction) ||
    /有哪些.*产品/.test(instruction) ||
    /所有产品/.test(instruction) ||
    /list .*products?|show .*products?/.test(normalized)
  ) {
    return "/api/products";
  }
  if (/余额|积分|credits?|wallet/.test(instruction) || /wallet|credit balance/.test(normalized)) {
    return "/api/wallet";
  }
  if (/帖子|发帖|排程|已发布|失败发布/.test(instruction) || /list .*posts?|scheduled posts?|failed posts?/.test(normalized)) {
    return "/api/posts";
  }
  if (/已连接.*平台|平台.*连接|platforms?/.test(instruction) || /connected platforms?/.test(normalized)) {
    return "/api/platforms";
  }
  if (/状态|概况/.test(instruction) || /cmo status|account status/.test(normalized)) {
    return "/api/cmo/status";
  }
  if (/feed|待处理|待审批|批准|审核/.test(normalized) || /待处理|待审批|批准|审核/.test(instruction)) {
    return "/api/cmo/feed";
  }
  return null;
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

type PollMessage = {
  message_id: number;
  role: string;
  content: string;
  message_kind?: string | null;
  pending_action?: { tool?: string; args?: unknown } | null;
  // Clickable action cards the CMO surfaces (media links, connect links). The
  // reply text never inlines raw URLs, so these carry the URLs an agent needs.
  actions?: Array<{ label?: string; url?: string; style?: string }> | null;
};

const server = new McpServer({ name: "autowhisper", version: "0.1.4" });

server.registerTool(
  "autowhisper_products_summary",
  {
    title: "AutoWhisper product counts",
    description: "Fast read-only product counts by account and workspace. Use for questions like 'how many products do I have?'.",
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
    description: "Fast read-only product list. Use instead of autowhisper_cmo when the user only wants to list/search current products.",
    inputSchema: {
      include_archived: z.boolean().optional().describe("Include archived products."),
      workspace_id: z.number().optional().describe("Optional workspace id."),
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
    description: "Fast read-only account/CMO snapshot: products, feed, connected platforms, wallet, and automation settings.",
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
    description: "Fast read-only CMO feed list with status counts and available actions. Use for pending review/feed/status questions.",
    inputSchema: {
      status: z.enum(["pending", "approved", "rejected", "dismissed", "executed", "all"]).optional().describe("Feed status to return. Defaults to pending."),
      workspace_id: z.number().optional().describe("Optional workspace id."),
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
    description: "Fast delivery-queue list for the active workspace. Use for scheduled, failed, and published post facts.",
    inputSchema: {
      status: z.enum(["draft", "scheduled", "publishing", "published", "failed"]).optional().describe("Optional post status filter."),
      workspace_id: z.number().optional().describe("Optional workspace id."),
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
    description: "Fast read-only connected-platform list and connection health for the active workspace.",
    inputSchema: { workspace_id: z.number().optional().describe("Optional workspace id.") },
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
    description: "Run an explicit feed or post action without an AI chat turn. High-impact actions return a confirmation message_id; confirm it with autowhisper_confirm.",
    inputSchema: {
      tool: z.enum(["approve_feed_item", "reject_feed_item", "dismiss_feed_item", "publish_content", "reschedule_post", "retry_post", "mark_as_published"]),
      feed_item_id: z.number().optional().describe("Required for feed actions."),
      post_id: z.number().optional().describe("Required for post actions."),
      scheduled_at: z.string().optional().describe("Required for reschedule_post; ISO8601 or natural language supported by AutoWhisper."),
      reason: z.string().optional().describe("Optional reason for rejecting a feed item."),
      workspace_id: z.number().optional().describe("Optional workspace id."),
    },
  },
  async ({ tool, feed_item_id, post_id, scheduled_at, reason, workspace_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const values: Record<string, string> = {};
    if (feed_item_id !== undefined) values.feed_item_id = String(feed_item_id);
    if (post_id !== undefined) values.post_id = String(post_id);
    if (scheduled_at !== undefined) values.scheduled_at = scheduled_at;
    if (reason !== undefined) values.reason = reason;
    if (workspace_id !== undefined) values.workspace_id = String(workspace_id);
    const result = await postForm<ActionResult>(`/api/cmo/actions/${tool}`, values);
    return result.error ? text(result.error, true) : text(formatAction(result.data || {}));
  },
);

server.registerTool(
  "autowhisper_edit_content",
  {
    title: "AutoWhisper edit content",
    description: "Directly update exact content fields without a generation run or credit spend. Pass body for the full replacement copy/story.",
    inputSchema: {
      content_type: z.enum(["social_copy", "lookbook", "feature_poster", "idea"]),
      content_id: z.number(),
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
    },
  },
  async ({ instruction, product_id }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    if (!product_id) {
      const path = fastReadPath(instruction);
      if (path) return handleFastRead(path);
    }

    // 1. send the instruction
    const body = new URLSearchParams({ message: instruction });
    if (product_id) body.set("product_id", product_id);
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
    const sent = (await send.json()) as { message_id?: number };
    const mid = sent.message_id;
    if (!mid) return text("AutoWhisper returned no message_id.", true);

    // 2. poll until the CMO finishes the turn
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let pr: Response;
      try {
        pr = await api(`/api/cmo/messages/${mid}`, { method: "GET" });
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
          const combined = [reply, linksText].filter(Boolean).join("\n\n");
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
    },
  },
  async ({ message_id, decision }) => {
    if (!TOKEN) return text(NO_TOKEN, true);
    const body = new URLSearchParams({ message_id: String(message_id), decision });
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
    if (res.status === 404) return text("Confirmation not found.", true);
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
