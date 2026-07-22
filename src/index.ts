#!/usr/bin/env node
/**
 * AutoWhisper MCP server.
 * Exposes AutoWhisper to any MCP client as a few tools:
 *   - autowhisper_cmo:              send an instruction, wait for the CMO's reply
 *   - autowhisper_products_summary: fast read-only product counts
 *   - autowhisper_products:         fast read-only product list
 *   - autowhisper_status:           fast read-only account/CMO status
 *   - autowhisper_confirm:          approve/decline a destructive action
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
  if (/状态|概况/.test(instruction) || /cmo status|account status/.test(normalized)) {
    return "/api/cmo/status";
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

const server = new McpServer({ name: "autowhisper", version: "0.1.2" });

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
      "Approve or decline a destructive action the CMO asked you to confirm (surfaced by autowhisper_cmo). Pass the message_id it gave you and decision \"yes\" or \"no\".",
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
