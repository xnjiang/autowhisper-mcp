#!/usr/bin/env node
/**
 * AutoWhisper MCP server.
 * Exposes AutoWhisper's CMO to any MCP client as two tools:
 *   - autowhisper_cmo:     send an instruction, wait for the CMO's reply
 *   - autowhisper_confirm: approve/decline a destructive action
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

const server = new McpServer({ name: "autowhisper", version: "0.1.1" });

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
