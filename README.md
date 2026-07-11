# AutoWhisper MCP

Drive your **AutoWhisper AI CMO** from any MCP client (Claude Desktop, Cursor, Windsurf, n8n, …) — add a product, generate on-brand content (UGC video, posts, images), approve, connect social accounts, and **publish across 30+ platforms**, all in natural language.

It's the same CMO as the AutoWhisper dashboard, exposed over MCP.

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

- **`autowhisper_cmo`** — send an instruction to your CMO and get its reply. e.g. *"Add my product https://mystore.com/widget and start the CMO"*, *"Generate a UGC video for my product"*, *"Publish the approved content"*.
- **`autowhisper_confirm`** — approve or decline a destructive action the CMO asks about.

## One-time setup

To publish, ask the CMO to connect a social account — OAuth platforms return a link you click once. After that, publishing is hands-off.

## Config

| Env var | Default | |
|---|---|---|
| `AUTOWHISPER_API_TOKEN` | — | **required** — your API token |
| `AUTOWHISPER_BASE_URL` | `https://autowhisper.xyz` | override for self-host/staging |

## License

MIT
