/**
 * Reasoning tiers BBF Code defines for every model it offers.
 *
 * They arrive in the environment as `OPENCODE_MODEL_VARIANTS`, a JSON array of
 * `{ id, body }`, because the embedding product configures this engine through
 * a v1 config document whose provider block the v2 catalog never reads. Both
 * the proxied provider and the local one register the identical set: a turn
 * that asks for a tier a model does not carry fails with
 * `VariantUnavailableError` and nothing on the stream.
 */

export interface VariantSpec {
  id: string
  body: Record<string, unknown>
}

/** Anything malformed yields no variants rather than a broken catalog. */
export function parseVariants(raw: string | undefined): VariantSpec[] {
  if (!raw) return []
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  })()
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item: { id?: unknown; body?: unknown }) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string") return []
    const body = item.body && typeof item.body === "object" ? (item.body as Record<string, unknown>) : {}
    return [{ id: item.id, body }]
  })
}
