---
"@gfxlabs/opencode-plugins-otel": patch
---

Fix user.prompt emitting subtask/subagent prompts as user input. Only root session prompts are now emitted. Also deduplicate user.prompt events caused by opencode delivering events twice.
