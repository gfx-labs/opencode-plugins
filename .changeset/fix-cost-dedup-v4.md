---
"@gfxlabs/opencode-plugins-otel": patch
---

Fix double-counting of cost/tokens: move cost and token fields to api.request only, deduplicate by message ID. PLUGIN_VERSION 4.
