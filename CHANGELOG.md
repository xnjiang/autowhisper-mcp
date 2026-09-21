# Changelog

## 0.8.0
- **`receipt_text` now wins over `message` in every action result.** The server
  has computed this sentence from the actual outcome since 2026-09-13 and writes
  it for the owner to read, while `message` is aimed at the model. Until now this
  package only read `message`, so an agent could report something less accurate
  than the dashboard said about the same action — the very regression the server
  field exists to prevent ("queued for sending" when zero ad channels accepted
  the piece). The language-neutral `scheduled: 0` warning still rides alongside.
- **New tool `autowhisper_performance`** (`GET /api/performance`). Shipped
  server-side 2026-09-01 and unreachable from here until now: an agent could
  publish all day and never find out whether anything landed. Returns the
  four-layer funnel, a per-channel breakdown and ad spend over the window.
  `ad_spend_cents` is rendered as *unknown* when `null` — `null` means we cannot
  answer, `0` asserts nothing was spent, and collapsing them invents a fact.
- **`boost_post` added to `autowhisper_action`.** It shipped server-side
  2026-08-28; the enum here is the only list the model ever sees, so the
  capability existed, was documented, and no agent could reach it.
- The server now publishes `direct_action_tools` and `receipt_field` in
  `GET /api/contract`, so this list has a live source to be checked against.

