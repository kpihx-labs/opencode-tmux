// biome-ignore-all lint/suspicious/noExplicitAny: V1↔V2 adapter boundary — V2 hook events and V1 client surface are normalized here.
/**
 * OpenCode 2 entry point for opencode-tmux.
 *
 * Adapts the V1 plugin (`src/index.ts`) to the V2 plugin contract with zero
 * logic duplication, matching `opencode-collab/v2/index.ts`.
 */
import { z } from "zod"
import { opencodeTmux } from "../src/index.ts"

function dataOf(event: any): any {
  return event?.data ?? event?.properties ?? {}
}

function sessionOf(event: any): string | undefined {
  const data = dataOf(event)
  return data?.sessionID ?? event?.sessionID
}

function textOfParts(body: any): string {
  const parts = Array.isArray(body?.parts) ? body.parts : []
  return parts
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text as string)
    .join("\n\n")
}

function toJsonSchema(args: Record<string, any> | undefined) {
  if (!args || Object.keys(args).length === 0) {
    return { type: "object", properties: {}, additionalProperties: false }
  }
  const schema: any = z.toJSONSchema(z.object(args))
  delete schema.$schema
  return schema
}

export default {
  id: "tmux",
  async setup(ctx: any) {
    const client = {
      session: {
        promptAsync: async ({ path, body }: any) => {
          const text = textOfParts(body)
          if (!text) return { data: undefined }
          const synthetic = Array.isArray(body?.parts) && body.parts.some((p: any) => p?.synthetic === true)
          if (synthetic && typeof ctx.session?.synthetic === "function") {
            await ctx.session.synthetic({ sessionID: path.id, text })
          } else {
            await ctx.session.prompt({ sessionID: path.id, text })
          }
          return { data: undefined }
        },
        prompt: async ({ path, body }: any) => {
          const text = textOfParts(body)
          if (!text) return { data: undefined }
          await ctx.session.prompt({ sessionID: path.id, text })
          return { data: undefined }
        },
      },
    }

    const hooks: any = await opencodeTmux()(
      { client, directory: ctx.location?.directory ?? process.cwd(), project: ctx.location?.project },
      ctx.options ?? {},
    )

    if (hooks.tool) {
      await ctx.tool.transform((editor: any) => {
        for (const [name, definition] of Object.entries<any>(hooks.tool)) {
          editor.add({
            name,
            description: definition.description ?? "",
            input: toJsonSchema(definition.args),
            async execute(input: any, toolContext: any) {
              const result = await definition.execute(input, {
                sessionID: toolContext?.sessionID,
                agent: toolContext?.agent,
                messageID: toolContext?.messageID,
                abort: toolContext?.signal,
                directory: toolContext?.directory ?? ctx.location?.directory,
              })
              if (typeof result === "string") return { content: result }
              if (typeof result === "number" || typeof result === "boolean") return { content: String(result) }
              return { content: JSON.stringify(result ?? null, null, 2) }
            },
          })
        }
      })
    }

    if (typeof hooks["chat.message"] === "function") {
      await ctx.session.hook("prompt", (event: any) => {
        if (!event?.prompt || typeof event.prompt.text !== "string") return
        const draft: any = { parts: [{ type: "text", text: event.prompt.text }] }
        void hooks["chat.message"]({ sessionID: event.sessionID }, draft)
        const parts = draft.parts.filter((part: any) => part?.type === "text")
        if (parts.length !== 1) event.prompt.text = parts.map((part: any) => part.text).join("\n\n")
      })
    }

    const controller = new AbortController()
    if (typeof hooks.event === "function" && typeof ctx.event?.subscribe === "function") {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            const type = (event as any)?.type
            const sessionID = sessionOf(event)
            if (!sessionID) continue
            if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.idle") {
              await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
            }
          }
        } catch {
          // subscription ends with plugin lifecycle
        }
      })()
    }

    return () => {
      try { controller.abort() } catch {}
      void hooks.dispose?.()
    }
  },
}
