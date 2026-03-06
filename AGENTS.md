# AGENTS.md

## Project Overview

TypeScript monorepo (Yarn 4 workspaces, `nodeLinker: node-modules`) containing plugins
for the opencode-ai platform. Currently one package: `packages/opencode-otel` -- an
OpenTelemetry usage-tracking plugin. ESM-only output via pkgroll. TypeScript 5.7+ in
strict mode. Versioning and publishing handled by changesets.

## Build / Typecheck / Clean Commands

```bash
# Build all packages
yarn build

# Build a single package
yarn workspace @gfxlabs/opencode-plugins-otel build

# Typecheck all packages (uses project references)
yarn typecheck

# Clean all build artifacts
yarn clean

# Clean a single package
yarn workspace @gfxlabs/opencode-plugins-otel clean
```

## Tests

No test infrastructure is configured yet. There is no test runner, no test scripts,
and no test files. If tests are added, follow the monorepo pattern and add a `test`
script to the relevant package's `package.json`.

## Linting / Formatting

No linter or formatter is configured (no eslint, prettier, biome, etc.).
Code style is enforced by convention -- see below.

## Code Style

### Formatting
- **2-space indentation**, no tabs
- **No semicolons** (ASI style)
- **Double quotes** for all strings -- never single quotes
- **Trailing commas** in multi-line function calls, arrays, and objects
- **No hard line-length limit**, but keep lines under ~120 characters
- Template literals (backticks) only for string interpolation

### Imports
- Use the `node:` protocol prefix for all Node.js stdlib imports (`"node:fs/promises"`, not `"fs/promises"`)
- Use `import type` for type-only imports (enforced by `verbatimModuleSyntax: true`)
- Import order: Node.js stdlib first, then third-party/external packages
- No blank lines between import groups

```ts
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode-ai/plugin"
```

### Naming Conventions
| Category | Convention | Example |
|---|---|---|
| Interfaces | `PascalCase` | `OtelConfig`, `OtelLogRecord` |
| Type aliases | `PascalCase` | `OtelAttr` |
| Functions | `camelCase` | `loadConfig`, `makeLogRecord` |
| Variables / params | `camelCase` | `resourceAttrs`, `flushTimer` |
| Constants | `UPPER_SNAKE_CASE` | `REDACTED` |
| Exported bindings | `PascalCase` | `OtelPlugin` |
| Package directories | `kebab-case` | `opencode-otel` |
| JSON/data properties | `snake_case` | `user_id`, `organization` |

### Types
- Prefer `unknown` over `any` -- never use `any`
- Use interfaces for domain objects / structured data shapes
- Use type aliases for small inline shapes or unions
- Use type assertions sparingly, only after a type guard confirms safety
- Inline object types are acceptable for one-off callback parameters
- Standard generics: `Record<string, string>`, `Record<string, unknown>`, etc.

### Functions
- Top-level named helpers use `function` declarations (not arrow functions)
- Callbacks, event handlers, and reducers use arrow functions
- Exported plugin factories are `async` arrow functions assigned to `const`

```ts
// Named helper: function declaration
function makeLogRecord(eventType: string, attrs: OtelAttr[]): OtelLogRecord {
  ...
}

// Callback: arrow function
.then((res) => { ... })

// Exported factory: async arrow assigned to const
export const OtelPlugin: Plugin = async ({ project, directory, client }) => {
  ...
}
```

### Exports
- **Named exports only** -- no default exports
- Only export what consumers need; keep helpers and types internal
- Explicitly type exported values with their interface

### Error Handling
- `try/catch` with bare `catch` (no error variable) for intentionally-ignored failures
- Return `undefined` on failure, callers handle with type guards and `??`
- `.catch()` on promises for fire-and-forget operations (e.g., telemetry sends)
- No custom error classes or Result types -- keep it pragmatic
- Use `void` to explicitly discard promise return values for fire-and-forget calls

```ts
// Silent fallback pattern
async function loadJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8"))
  } catch {
    return undefined
  }
}

// Fire-and-forget with void
void client.app.log({ level: "info", message: "..." })
```

### Control Flow
- Single-statement `if` bodies on the same line, no braces: `if (buffer.length === 0) return`
- Multi-statement `if` bodies always use braces
- K&R brace style (opening brace on the same line)
- Use `??` for nullish coalescing, `||` for falsy coalescing -- choose intentionally
- Use optional chaining (`?.`) freely
- Use numeric separators for large numbers: `1_000_000`, `5_000`

### Comments
- No JSDoc
- Use `//` single-line comments only (no block `/* */` comments)
- Comments explain "why", not "what" -- code should be self-documenting
- Short inline annotations are acceptable for non-obvious values: `severityNumber: 9, // INFO`

## Project Structure

```
opencode-plugins/                  # monorepo root
  packages/
    <package-name>/                # each plugin package
      src/
        index.ts                   # entry point
      dist/                        # build output (gitignored)
      package.json
      tsconfig.json                # extends root tsconfig
  tsconfig.json                    # shared base TS config
  tsconfig.build.json              # project references for build
  package.json                     # workspace root
```

## TypeScript Configuration

- Target: ES2022
- Module: ESNext with bundler resolution
- Strict mode enabled
- `composite: true` with project references
- `verbatimModuleSyntax: true` -- requires explicit `import type`
- `isolatedModules: true`
- Declaration files and source maps are generated

## Adding a New Package

1. Create `packages/<package-name>/` with `src/index.ts`, `package.json`, `tsconfig.json`
2. Package `tsconfig.json` should extend the root: `"extends": "../../tsconfig.json"`
3. Set `rootDir: "src"` and `outDir: "dist"` in the package tsconfig
4. Add the package to `tsconfig.build.json` references
5. Use `pkgroll` as the build tool (add `"build": "pkgroll"` script)
6. Declare `@opencode-ai/plugin` as a peer dependency (`>=1.0.0`)
7. Set `"type": "module"` and configure `exports` for dual CJS/ESM output

## Releasing

Releases are managed by [changesets](https://github.com/changesets/changesets) and
published to npm via GitHub Actions.

### Adding a changeset

When you make a change that should result in a version bump, add a changeset:

```bash
yarn changeset
```

This prompts you to:
1. Select which package(s) changed
2. Choose the semver bump type (patch / minor / major)
3. Write a short summary of the change

It creates a markdown file in `.changeset/` -- commit this file with your PR.

If a change does not need a release (e.g. docs-only, CI config), skip the changeset
or run `yarn changeset --empty` to explicitly mark it as no-release.

### How the release workflow works

Two GitHub Actions workflows handle CI and releases:

- **CI** (`.github/workflows/ci.yml`) -- runs `yarn typecheck` and `yarn build` on
  every push to `master` and on every PR targeting `master`.

- **Release** (`.github/workflows/release.yml`) -- runs on push to `master`. First
  runs a `ci` job (typecheck + build). If that passes, the `release` job runs
  `changesets/action@v1`, which does one of two things:

  1. **Pending changesets exist:** opens (or updates) a PR titled "chore: version
     packages" that bumps versions in `package.json`, consumes the changeset files,
     and writes/updates `CHANGELOG.md`.

  2. **No pending changesets** (i.e. the version PR was just merged): runs
     `changeset publish` which publishes to npm and creates git tags.

### Release steps

1. Make changes on a branch, add a changeset, open a PR.
2. Merge the PR to `master`.
3. The release workflow runs CI checks, then opens a "chore: version packages" PR
   with the version bump.
4. Review and merge the version PR.
5. The release workflow runs again, CI passes, and it publishes to npm.

### npm authentication

Publishing uses npm trusted publishing via GitHub Actions OIDC (`id-token: write`
permission). The `@gfxlabs` scope is configured as a trusted publisher on npmjs.com
linked to the `gfx-labs/opencode-plugins` repository and the `release.yml` workflow.
No `NPM_TOKEN` secret is needed. Provenance attestations are generated automatically.

### Package requirements for publishing

Each publishable package must have a `repository` field in its `package.json` that
matches the GitHub repo URL. npm verifies this against the provenance signature
during trusted publishing:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/gfx-labs/opencode-plugins",
  "directory": "packages/<package-name>"
}
```

Packages must also have `main` and `types` top-level fields in addition to `exports`
for bun compatibility.

### Manual version commands

```bash
# Apply pending changesets to bump versions and update changelogs
yarn cs:version

# Publish all packages with new versions to npm
yarn cs:publish
```
