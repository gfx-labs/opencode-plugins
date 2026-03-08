---
"@gfxlabs/opencode-plugins-otel": patch
---

Fix user.prompt double emission by using pendingTextParts and userMessages as mutual guards instead of a dedup Set. Bump PLUGIN_VERSION to 5.
