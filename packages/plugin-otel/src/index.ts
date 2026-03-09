import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { loadConfig } from "./config.js"
import { detectGitInfo } from "./git.js"
import { toolExecuted } from "./events.js"
import type { OtelResourceAttr } from "./otel.js"
import { lineCount, safeStringifyLength } from "./otel.js"
import { EmitContext } from "./context.js"
import type { LogFn } from "./context.js"
import { createHandlers, DRAIN_EVENTS } from "./handlers.js"

const PLUGIN_VERSION = 5

export const OtelPlugin: Plugin = async ({ project, directory, client }) => {
  const config = await loadConfig(directory)

  const enabledViaEnv = process.env.OPENCODE_OTEL_ENABLED === "1"
  if (!enabledViaEnv && config.enabled !== true) {
    await client.app.log({
      body: { service: "opencode-otel", level: "info", message: "disabled (set enabled: true in .opencode/otel.json or OPENCODE_OTEL_ENABLED=1)" },
    })
    return {}
  }

  const redactLevel = config.redact ?? "full"

  await client.app.log({
    body: { service: "opencode-otel", level: "info", message: `enabled, endpoint=${config.endpoint ?? "none"}, redact=${redactLevel}` },
  })

  const gitInfo = await detectGitInfo(directory)

  // Env vars take precedence over config
  const endpoint = process.env.OPENCODE_OTEL_ENDPOINT || config.endpoint
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  // Config file headers first
  if (config.headers) {
    Object.assign(headers, config.headers)
  }

  // Env headers override config headers (key=value,key=value)
  const envHeaders = process.env.OPENCODE_OTEL_HEADERS
  if (envHeaders) {
    for (const pair of envHeaders.split(",")) {
      const eq = pair.indexOf("=")
      if (eq > 0) {
        headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
      }
    }
  }

  const resourceAttrs: OtelResourceAttr[] = [
    { key: "service.name", value: { stringValue: "opencode" } },
    { key: "organization.id", value: { stringValue: config.organization ?? "unset" } },
    { key: "deployment.environment", value: { stringValue: config.environment ?? "default" } },
    { key: "project.id", value: { stringValue: project.id } },
    { key: "plugin.version", value: { intValue: PLUGIN_VERSION } },
  ]
  resourceAttrs.push({
    key: "project.name",
    value: { stringValue: config.project_name ?? "default" },
  })
  if (config.user_id) {
    resourceAttrs.push({
      key: "user.id",
      value: { stringValue: config.user_id },
    })
  }

  const log: LogFn = (level, message) => {
    void client.app.log({
      body: { service: "opencode-otel", level, message },
    })
  }

  const ctx = new EmitContext({
    logsUrl: endpoint ? endpoint.replace(/\/$/, "") + "/v1/logs" : undefined,
    headers,
    resourceAttrs,
    redactLevel,
    log,
    loadProviders: async () => {
      const res = await client.provider.list()
      return res.data?.all ?? []
    },
  })

  // Git info uses rt() from the context for redaction
  if (gitInfo.remoteUrl) {
    resourceAttrs.push({
      key: "vcs.repository.url.full",
      value: { stringValue: ctx.rt(gitInfo.remoteUrl) },
    })
  }
  if (gitInfo.branch) {
    resourceAttrs.push({
      key: "vcs.ref.head.name",
      value: { stringValue: ctx.rt(gitInfo.branch) },
    })
  }
  if (gitInfo.commit) {
    resourceAttrs.push({
      key: "vcs.ref.head.revision",
      value: { stringValue: gitInfo.commit },
    })
  }

  const handlers = createHandlers(ctx)

  // Ensure buffered records are flushed before the process exits.
  // opencode may not await the plugin's event handler on session.idle
  // before disposing the instance, so drain() in the event hook can be
  // skipped. beforeExit fires when the event loop empties and gives us
  // a chance to flush synchronously (the fetch with keepalive: true
  // will outlive the process).
  process.on("beforeExit", () => {
    ctx.flush()
  })

  return {
    event: async ({ event }) => {
      const handler = handlers[event.type] as ((event: Event) => Promise<void> | void) | undefined
      if (handler) await handler(event)
      if (DRAIN_EVENTS.has(event.type)) await ctx.drain()
    },

    "tool.execute.after": async (input, output) => {
      ctx.track(input.sessionID)
      ctx.emit(toolExecuted({
        name: input.tool,
        callID: input.callID,
        title: ctx.rt(output.title),
        argsSize: safeStringifyLength(input.args),
        outputSize: output.output?.length,
        outputLines: output.output ? lineCount(output.output) : undefined,
        hasMetadata: output.metadata !== undefined && output.metadata !== null,
      }))
    },
  }
}
