import { Effect } from "effect"
import { define } from "../internal"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { ConfigProviderOptionsV1 } from "../../v1/config/provider-options"
import { parseVariants } from "./variants"

/**
 * Models served from the user's own machine.
 *
 * BBF Code discovers the local runtime itself -- it needs the same list for its
 * model picker -- and hands the result over in the environment, so this plugin
 * only has to register what it is given. Both variables are absent when no
 * runtime is reachable, and then no local provider exists at all.
 *
 * Requests use the runtime's OpenAI-compatible surface, which is what
 * `OpenAICompatiblePlugin` already knows how to build an SDK for. The api key is
 * a placeholder: local runtimes ignore it, but the catalog treats a provider
 * without one as unavailable.
 */

const PROVIDER_ID = "local"
const PLACEHOLDER_API_KEY = "local"

interface LocalModel {
  id: string
  name: string
  /**
   * The model requests are addressed to when it differs from `id`: BBF Code
   * registers a copy of each local model that carries a wider context window
   * than the runtime's default, and points requests at the copy.
   */
  wireId?: string
  contextLength: number
  maxOutputTokens: number
  tools: boolean
}

export const BbfLocalPlugin = define({
  id: "bbf-local",
  effect: Effect.fn(function* (ctx) {
    const baseURL = process.env.OPENCODE_LOCAL_BASE_URL
    const models = parseModels(process.env.OPENCODE_LOCAL_MODELS)
    if (!baseURL || models.length === 0) return

    // The same reasoning tiers the proxied provider offers. Without them a turn
    // that asks for one fails with VariantUnavailableError and nothing on the
    // stream, so local models must carry the identical set.
    const lowerer = ConfigProviderOptionsV1.get("@ai-sdk/openai-compatible")
    const variants = parseVariants(process.env.OPENCODE_MODEL_VARIANTS).map((variant) => ({
      id: ModelV2.VariantID.make(variant.id),
      headers: {},
      body: lowerer.request({ ...variant.body }),
    }))

    yield* ctx.catalog.transform((catalog) => {
      catalog.provider.update(ProviderV2.ID.make(PROVIDER_ID), (provider) => {
        provider.name = "Local AI"
        provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: baseURL }
        provider.request.body.apiKey = PLACEHOLDER_API_KEY
      })

      for (const model of models) {
        catalog.model.update(ProviderV2.ID.make(PROVIDER_ID), ModelV2.ID.make(model.id), (draft) => {
          draft.name = model.name
          // Left as the empty native api on purpose: the catalog then projects
          // the provider's own api onto the model, so the URL and package stay
          // defined in exactly one place. The id on the wire is the copy with
          // the wide window when BBF Code made one; the model keeps its own id.
          draft.api.id = ModelV2.ID.make(model.wireId ?? model.id)
          draft.capabilities.tools = model.tools
          // An empty modality list would leave the model unable to carry a
          // prompt; these runtimes are text in, text out.
          draft.capabilities.input = ["text"]
          draft.capabilities.output = ["text"]
          draft.limit = { context: model.contextLength, output: model.maxOutputTokens }
          draft.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
          draft.status = "active"
          draft.enabled = true
          draft.variants = variants.map((variant) => ({ ...variant, body: { ...variant.body } }))
        })
      }
    })
  }),
})

/** Reads OPENCODE_LOCAL_MODELS; anything malformed yields no local models. */
function parseModels(raw: string | undefined): LocalModel[] {
  if (!raw) return []
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  })()
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item: Partial<LocalModel>) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string") return []
    return [
      {
        id: item.id,
        name: typeof item.name === "string" ? item.name : item.id,
        wireId: typeof item.wireId === "string" && item.wireId ? item.wireId : undefined,
        contextLength: typeof item.contextLength === "number" ? item.contextLength : 32_768,
        maxOutputTokens: typeof item.maxOutputTokens === "number" ? item.maxOutputTokens : 4_096,
        tools: item.tools !== false,
      },
    ]
  })
}
