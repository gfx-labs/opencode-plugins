---
"@gfxlabs/opencode-plugins-otel": patch
---

Extract EmitContext class to dedicated context.ts module for cleaner separation of transport, buffering, and dedup state from the plugin entry point.
