---
"@gfxlabs/opencode-plugins-otel": patch
---

fix(otel): flush buffered records on beforeExit to prevent data loss when opencode disposes the instance without awaiting plugin event handlers
