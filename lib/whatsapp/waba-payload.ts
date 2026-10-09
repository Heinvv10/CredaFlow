export type ParsedMessage = {
  fromPhone: string
  text: string
  providerMessageId: string | null
}

export type WabaStatus = {
  providerMessageId: string
  status: string // sent | delivered | read | failed
}

export function parseWabaPayload(payload: unknown): ParsedMessage | null {
  if (typeof payload !== "object" || payload === null) return null
  const p = payload as Record<string, unknown>
  const entries = Array.isArray(p.entry) ? p.entry : null
  if (!entries || entries.length === 0) return null
  const e0 = entries[0]
  if (typeof e0 !== "object" || e0 === null) return null
  const changes = Array.isArray((e0 as Record<string, unknown>).changes)
    ? (e0 as Record<string, unknown>).changes as unknown[]
    : null
  if (!changes || changes.length === 0) return null
  const c0 = changes[0]
  if (typeof c0 !== "object" || c0 === null) return null
  const value = (c0 as Record<string, unknown>).value as Record<string, unknown> | undefined
  if (typeof value !== "object" || value === null) return null
  const messages = Array.isArray(value.messages) ? value.messages : null
  if (!messages || messages.length === 0) return null
  const m0 = messages[0]
  if (typeof m0 !== "object" || m0 === null) return null
  const fromPhone = typeof m0.from === "string" ? m0.from : null
  const text = (m0.text && typeof (m0.text as Record<string, unknown>).body === "string")
    ? ((m0.text as Record<string, unknown>).body as string)
    : null
  const providerMessageId = typeof m0.id === "string" ? m0.id : null
  if (!fromPhone || !text) return null
  return { fromPhone, text, providerMessageId }
}

/**
 * The WhatsApp Business Account id from `entry[].id`.
 *
 * Needed because not every webhook is number-scoped: a
 * `message_template_status_update` is a WABA-LEVEL event and carries no
 * `value.metadata.phone_number_id`, so `parseWabaPhoneNumberId` returns null
 * for it and the route cannot resolve a tenant by number. Falling back to
 * NEXT_PUBLIC_TENANT_SLUG would attribute another tenant's template approval
 * to whichever tenant that env var names.
 */
export function parseWabaAccountId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null
  const p = payload as Record<string, unknown>
  const entries = Array.isArray(p.entry) ? p.entry : []
  for (const e of entries) {
    if (typeof e !== "object" || e === null) continue
    const id = (e as Record<string, unknown>).id
    if (typeof id === "string" && id) return id
  }
  return null
}

export function parseWabaPhoneNumberId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null
  const p = payload as Record<string, unknown>
  const entries = Array.isArray(p.entry) ? p.entry : []
  for (const e of entries) {
    if (typeof e !== "object" || e === null) continue
    const changes = Array.isArray((e as Record<string, unknown>).changes) ? (e as Record<string, unknown>).changes as unknown[] : []
    for (const c of changes) {
      if (typeof c !== "object" || c === null) continue
      const value = (c as Record<string, unknown>).value as Record<string, unknown> | undefined
      const metadata = value?.metadata as Record<string, unknown> | undefined
      const id = metadata?.phone_number_id
      if (typeof id === "string" && id) return id
    }
  }
  return null
}

export function parseWabaStatuses(payload: unknown): WabaStatus[] {
  if (typeof payload !== "object" || payload === null) return []
  const p = payload as Record<string, unknown>
  const entries = Array.isArray(p.entry) ? p.entry : []
  const out: WabaStatus[] = []
  for (const e of entries) {
    if (typeof e !== "object" || e === null) continue
    const changes = Array.isArray((e as Record<string, unknown>).changes) ? (e as Record<string, unknown>).changes as unknown[] : []
    for (const c of changes) {
      if (typeof c !== "object" || c === null) continue
      const value = (c as Record<string, unknown>).value as Record<string, unknown> | undefined
      const statuses = value && Array.isArray(value.statuses) ? value.statuses as unknown[] : []
      for (const s of statuses) {
        if (typeof s !== "object" || s === null) continue
        const sr = s as Record<string, unknown>
        if (typeof sr.id === "string" && typeof sr.status === "string") {
          out.push({ providerMessageId: sr.id, status: sr.status })
        }
      }
    }
  }
  return out
}
