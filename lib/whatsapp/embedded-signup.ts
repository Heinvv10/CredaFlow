function graphVersion(): string {
  return process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0"
}

/** Exchange the Embedded Signup auth code for a business system-user token. */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const appId = process.env.NEXT_PUBLIC_META_APP_ID
  const appSecret = process.env.WHATSAPP_CLOUD_APP_SECRET
  if (!appId || !appSecret) throw new Error("Embedded Signup app credentials are not configured")
  const url =
    `https://graph.facebook.com/${graphVersion()}/oauth/access_token` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&code=${encodeURIComponent(code)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error")
    throw new Error(`Embedded Signup token exchange ${res.status}: ${text}`)
  }
  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) throw new Error("Embedded Signup returned no access_token")
  return data.access_token
}

/** Subscribe our Tech-Provider app to the tenant's WABA webhooks. */
export async function subscribeAppToWaba(wabaId: string, token: string): Promise<void> {
  const url = `https://graph.facebook.com/${graphVersion()}/${wabaId}/subscribed_apps`
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error")
    throw new Error(`Embedded Signup subscribe ${res.status}: ${text}`)
  }
}
