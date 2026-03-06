import { writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CONFIG_FIELDS } from "../src/config.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

interface JsonSchemaProperty {
  type: string
  description: string
  default?: unknown
  format?: string
  enum?: readonly string[]
  examples?: unknown[]
  additionalProperties?: { type: string }
}

const properties: Record<string, JsonSchemaProperty> = {}

for (const field of CONFIG_FIELDS) {
  let schemaType: string
  switch (field.type) {
    case "headers":
      schemaType = "object"
      break
    case "enum":
      schemaType = "string"
      break
    default:
      schemaType = field.type
  }
  const prop: JsonSchemaProperty = {
    type: schemaType,
    description: field.description,
  }
  if (field.default !== undefined) prop.default = field.default
  if (field.format) prop.format = field.format
  if (field.enum) prop.enum = field.enum
  if (field.examples) prop.examples = field.examples
  if (field.type === "headers") {
    prop.additionalProperties = { type: "string" }
  }
  properties[field.key] = prop
}

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://raw.githubusercontent.com/gfx-labs/opencode-plugins/main/packages/opencode-otel/otel.schema.json",
  title: "opencode-otel config",
  description: "Configuration for the @gfxlabs/opencode-plugins-otel plugin. Place as .opencode/otel.json (project) or ~/.config/opencode/otel.json (global).",
  type: "object",
  properties,
  additionalProperties: false,
}

const outPath = join(__dirname, "..", "otel.schema.json")
writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n")
console.log(`wrote ${outPath}`)
