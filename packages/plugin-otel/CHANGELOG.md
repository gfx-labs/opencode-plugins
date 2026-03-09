# @gfxlabs/opencode-plugins-otel

## 0.1.11

### Patch Changes

- [`3d425e4`](https://github.com/gfx-labs/opencode-plugins/commit/3d425e48c0371a1ed8046007f253b28f7764347a) Thanks [@elee1766](https://github.com/elee1766)! - Extract EmitContext class to dedicated context.ts module for cleaner separation of transport, buffering, and dedup state from the plugin entry point.

## 0.1.10

### Patch Changes

- [`cd5cc12`](https://github.com/gfx-labs/opencode-plugins/commit/cd5cc123b1f403027b9d01a98048c865e5a37759) Thanks [@elee1766](https://github.com/elee1766)! - fix(otel): flush buffered records on beforeExit to prevent data loss when opencode disposes the instance without awaiting plugin event handlers

## 0.1.9

### Patch Changes

- [`9b54d28`](https://github.com/gfx-labs/opencode-plugins/commit/9b54d283bc7adf1b3c3f37677754e2084c93c14f) Thanks [@elee1766](https://github.com/elee1766)! - Fix user.prompt double emission by using pendingTextParts and userMessages as mutual guards instead of a dedup Set. Bump PLUGIN_VERSION to 5.

## 0.1.8

### Patch Changes

- [`8532f9a`](https://github.com/gfx-labs/opencode-plugins/commit/8532f9aa2f7447ff9c703240a91757ae45e98213) Thanks [@elee1766](https://github.com/elee1766)! - Fix user.prompt emitting subtask/subagent prompts as user input. Only root session prompts are now emitted. Also deduplicate user.prompt events caused by opencode delivering events twice. Fix cost estimation returning $0 for models whose provider list key differs from model.id by storing costs under both identifiers.

## 0.1.7

### Patch Changes

- [`34967f9`](https://github.com/gfx-labs/opencode-plugins/commit/34967f97f87bee1b95ac5113476a6e406cd61ebb) Thanks [@elee1766](https://github.com/elee1766)! - Fix user.prompt emitting subtask/subagent prompts as user input. Only root session prompts are now emitted. Also deduplicate user.prompt events caused by opencode delivering events twice.

## 0.1.6

### Patch Changes

- [`ea49079`](https://github.com/gfx-labs/opencode-plugins/commit/ea4907961c84a57ac332fd7bfd112a40a2958b9b) Thanks [@elee1766](https://github.com/elee1766)! - Only estimate cost for Anthropic provider; other providers report cost accurately or use subscription plans where $0 is correct

## 0.1.5

### Patch Changes

- [`ae60110`](https://github.com/gfx-labs/opencode-plugins/commit/ae601104e3aded198bf990baa12e66d3938d296c) Thanks [@elee1766](https://github.com/elee1766)! - Fix double-counting of cost/tokens: move cost and token fields to api.request only, deduplicate by message ID. PLUGIN_VERSION 4.

## 0.1.4

### Patch Changes

- [`9a94b88`](https://github.com/gfx-labs/opencode-plugins/commit/9a94b88cba5860003490aed7a5d0b48c336e2606) Thanks [@elee1766](https://github.com/elee1766)! - Add prompt.content to user.prompt events (redacted via rt()), bump PLUGIN_VERSION to 3, update docs for npm plugin install flow

## 0.1.3

### Patch Changes

- [`3756801`](https://github.com/gfx-labs/opencode-plugins/commit/37568016aa1e72e084119beeb906c74a14af707e) Thanks [@elee1766](https://github.com/elee1766)! - Add main and types fields for bun compatibility

## 0.1.2

### Patch Changes

- [`d885eea`](https://github.com/gfx-labs/opencode-plugins/commit/d885eeace883ef0c786c6cb0f3850fa8f5832c7d) Thanks [@elee1766](https://github.com/elee1766)! - Add repository field for npm provenance, install peer deps for CI typecheck

## 0.1.1

### Patch Changes

- [`f63605c`](https://github.com/gfx-labs/opencode-plugins/commit/f63605c2c548a1414ddfcc5ff0e925cdc02f4a8b) Thanks [@elee1766](https://github.com/elee1766)! - Allow `$`-prefixed keys (e.g. `$schema`) in otel config JSON files
