import type { WaTemplateCreateComponent } from "./template-create"

/** Canonical definition — re-exported by lib/whatsapp-cloud-config.ts, which
 * is where these creds are read. Declared here so this module stays free of
 * the prisma import that config carries. */
export type WabaTemplateCreds = { wabaId: string; accessToken: string }

function graphVersion(): string {
  return process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0"
}

export async function createWabaTemplate(
  creds: WabaTemplateCreds,
  input: { name: string; language: string; category: string; components: WaTemplateCreateComponent[] },
): Promise<{ id: string; status: string }> {
  const url = `https://graph.facebook.com/${graphVersion()}/${creds.wabaId}/message_templates`
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      language: input.language,
      category: input.category,
      components: input.components,
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error")
    throw new Error(`WhatsApp Cloud template create ${res.status}: ${text}`)
  }
  const data = (await res.json()) as { id?: string; status?: string }
  return { id: data.id ?? "", status: data.status ?? "PENDING" }
}

export async function fetchWabaTemplateStatus(
  creds: WabaTemplateCreds,
  name: string,
): Promise<string | null> {
  const url = `https://graph.facebook.com/${graphVersion()}/${creds.wabaId}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,id`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error")
    throw new Error(`WhatsApp Cloud template status ${res.status}: ${text}`)
  }
  const data = (await res.json()) as { data?: Array<{ name?: string; status?: string }> }
  const match = data.data?.find((t) => t.name === name)
  return match?.status ?? null
}
