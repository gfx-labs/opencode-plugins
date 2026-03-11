import type { OpencodeClient, GeneratedMetadata } from "./types.js"
import type { TextPart } from "@opencode-ai/sdk"

function fallbackMetadata(content: string): GeneratedMetadata {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0) || "Delegation result"
  const title = firstLine.slice(0, 30).trim() + (firstLine.length > 30 ? "..." : "")
  const description = content.slice(0, 150).trim() + (content.length > 150 ? "..." : "")
  return { title, description }
}

// Generate title and description from result content using small_model
// Falls back to truncation if small_model is unavailable
export async function generateMetadata(
  client: OpencodeClient,
  resultContent: string,
  parentID: string,
  debugLog: (msg: string) => Promise<void>,
): Promise<GeneratedMetadata> {
  try {
    const config = await client.config.get()
    const configData = config.data as { small_model?: string } | undefined

    if (!configData?.small_model) {
      await debugLog("generateMetadata: no small_model configured, using fallback")
      return fallbackMetadata(resultContent)
    }

    await debugLog(`generateMetadata: using small_model ${configData.small_model}`)

    const session = await client.session.create({
      body: {
        title: "Metadata Generation",
        parentID,
      },
    })

    if (!session.data?.id) {
      await debugLog("generateMetadata: failed to create session")
      return fallbackMetadata(resultContent)
    }

    const prompt = `Generate a title and description for this research result.

RULES:
- Title: 2-5 words, max 30 characters, sentence case
- Description: 2-3 sentences, max 150 characters, summarize key findings

RESULT CONTENT:
${resultContent.slice(0, 2000)}

Respond with ONLY valid JSON in this exact format:
{"title": "Your Title Here", "description": "Your description here."}`

    const PROMPT_TIMEOUT_MS = 30_000
    const result = await Promise.race([
      client.session.prompt({
        path: { id: session.data.id },
        body: {
          parts: [{ type: "text", text: prompt }],
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Prompt timeout after 30s")), PROMPT_TIMEOUT_MS),
      ),
    ])

    const responseParts = result.data?.parts as TextPart[] | undefined
    const textPart = responseParts?.find((p): p is TextPart => p.type === "text")
    if (!textPart) {
      await debugLog("generateMetadata: no text part in response")
      return fallbackMetadata(resultContent)
    }

    const jsonMatch = textPart.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      await debugLog(`generateMetadata: no JSON found in response: ${textPart.text}`)
      return fallbackMetadata(resultContent)
    }

    const parsed = JSON.parse(jsonMatch[0]) as { title?: string; description?: string }
    if (!parsed.title || !parsed.description) {
      await debugLog("generateMetadata: invalid JSON structure")
      return fallbackMetadata(resultContent)
    }

    await debugLog(`generateMetadata: generated title="${parsed.title}"`)
    return {
      title: parsed.title.slice(0, 30),
      description: parsed.description.slice(0, 150),
    }
  } catch (error) {
    await debugLog(
      `generateMetadata error: ${error instanceof Error ? error.message : "Unknown error"}`,
    )
    return fallbackMetadata(resultContent)
  }
}
