# AutoWhisper MCP

A marketing department for any MCP client (Claude Desktop, Cursor, Windsurf, n8n, …) — turn your product into **batches of ready-to-run ad creatives** (UGC video, posts, images), get advice on **which creative to fund**, and keep **every channel alive across 30+ platforms**, all in natural language.

It's the same CMO as the AutoWhisper dashboard, exposed over MCP. Honest scope: posting ≠ traffic — reach comes from your paid campaigns; this makes sure the creatives convert and your storefront doesn't kill them.

## Install

Add to your MCP client config (Claude Desktop / Cursor / etc.):

```json
{
  "mcpServers": {
    "autowhisper": {
      "command": "npx",
      "args": ["-y", "autowhisper-mcp"],
      "env": { "AUTOWHISPER_API_TOKEN": "your_token_here" }
    }
  }
}
```

Get your token at **[autowhisper.xyz/skill](https://autowhisper.xyz/skill)** → **Settings → Connect your agent → Generate token**. New accounts get free credits.

## Tools

- **`autowhisper_cmo`** — send an instruction to your CMO and get its reply. e.g. *"Make a batch of ad creatives for my product https://mystore.com/widget"*, *"Which creative should I run first?"*, *"Keep my channels posted this week"*.
- **`autowhisper_products_summary`** — fast product counts by account/workspace. Use for *"how many products do I have?"* instead of spending a CMO chat turn.
- **`autowhisper_products`** — fast product list, with optional workspace/archive filters.
- **`autowhisper_status`** — fast CMO/account snapshot: products, feed, platforms, wallet, and automation settings.
- **`autowhisper_confirm`** — approve or decline a destructive action the CMO asks about.

> **Adding a product:** lead with a product **URL** (*"add my product https://mystore.com/widget"*) — the CMO extracts the image from the page. A text-only description won't create it (placeholder/stock images are rejected).

## One-time setup

To publish, ask the CMO to connect a social account — OAuth platforms return a link you click once. After that, publishing is hands-off.

## Config

| Env var | Default | |
|---|---|---|
| `AUTOWHISPER_API_TOKEN` | — | **required** — your API token |
| `AUTOWHISPER_BASE_URL` | `https://autowhisper.xyz` | override for self-host/staging |

## License

MIT
