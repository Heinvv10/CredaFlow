// Inbound email polling — the transport layer. Pulls messages from IMAP or MS
// Graph and hands each one to the record layer (lib/email/record-inbound.ts):
// the X-Lms-Ref loan-note continuity path and the comms-hub threading path.
//
// Shared by the admin "Poll Inbox" button and the /api/cron/email-poll sweep;
// returns plain data (no NextResponse) so callers wrap it as they like. Writes
// are tenant-scoped in the record layer, so this is safe under withoutTenantScope.

import { parseInboundEmail, mapGraphMessage, type GraphMessage } from "./parse-inbound"
import { recordEmailReply, recordInboundEmailMessage } from "./record-inbound"
import { prisma } from "@/lib/prisma"
import { openField } from "./secrets"
import { assertInboundHostAllowed, InboundHostBlockedError, isUnrestricted } from "./inbound-host-guard"

export type InboundPollResult = {
  ok: boolean
  checked?: number
  matched?: number
  message?: string
}

export type InboundPollConfig = {
  provider: string
  fromAddress: string
  tenantAzureId: string | null
  clientId: string | null
  clientSecret: string | null
  imapHost: string | null
  imapPort: number | null
  imapUser: string | null
  imapPass: string | null
  useTls: boolean
}

const MAX_POLL_ERROR = 512

/** The stored error is rendered to staff on /settings/email, so it is capped
 * at the column width rather than truncated by Postgres (which would throw). */
function pollErrorFor(result: InboundPollResult): string | null {
  if (result.ok) return null
  return (result.message ?? "Poll failed").slice(0, MAX_POLL_ERROR)
}

export async function pollTenantInbox(config: InboundPollConfig, tenantId: string): Promise<InboundPollResult> {
  const result =
    config.provider === "MSGRAPH" ? await pollMsGraph(config, tenantId) : await pollImap(config, tenantId)
  await recordPollOutcome(tenantId, result)
  return result
}

/** Persists every poll outcome so a failing mailbox is visible in the UI and
 * not just in a container log nobody retains. Best-effort BY DESIGN: a write
 * failure here must not convert a successful poll into a reported failure —
 * the cron's exit status is driven by the poll, not by the bookkeeping. */
async function recordPollOutcome(tenantId: string, result: InboundPollResult): Promise<void> {
  try {
    await prisma.emailConfig.update({
      where: { tenantId },
      data: { lastPollAt: new Date(), lastPollOk: result.ok, lastPollError: pollErrorFor(result) },
    })
  } catch (e) {
    console.error("[inbound-poll] failed to persist poll outcome", { tenantId }, e)
  }
}

async function pollImap(config: InboundPollConfig, tenantId: string): Promise<InboundPollResult> {
  // Hoisted so the outer catch can redact it out of a leaked provider error
  // message even if the failure happens before/during opening the secret.
  let openedPass: string | undefined
  try {
    if (!config.imapHost || !config.imapUser || !config.imapPass) {
      return { ok: false, message: "IMAP config incomplete" }
    }

    // A non-production box must not read the production mailbox: it would
    // thread real customer mail and race production's own poll for it.
    try {
      assertInboundHostAllowed(config.imapHost)
    } catch (e) {
      if (e instanceof InboundHostBlockedError) return { ok: false, message: e.message }
      throw e
    }

    openedPass = openField(config.imapPass)
    const { ImapFlow } = await import("imapflow")
    const client = new ImapFlow({
      host: config.imapHost,
      port: config.imapPort ?? 993,
      secure: true,
      auth: { user: config.imapUser, pass: openedPass },
      logger: false,
    })

    await client.connect()
    try {
      const lock = await client.getMailboxLock("INBOX")
      let matched = 0
      let checked = 0

      try {
        const since = new Date(Date.now() - 7 * 86400000)
        for await (const msg of client.fetch(
          { since },
          { envelope: true, source: true, headers: ["x-lms-ref", "x-lms-category"] },
        )) {
          checked++

          // (1) Existing loan-note continuity path (X-Lms-Ref → loan).
          const hdrsMap = msg.headers as unknown as Map<string, string[]>
          const refValues = hdrsMap?.get?.("x-lms-ref")
          const refHeader = Array.isArray(refValues) ? refValues[0] : null
          if (refHeader) {
            const noted = await recordEmailReply(tenantId, {
              loanId: refHeader.trim(),
              subject: msg.envelope?.subject ?? "(no subject)",
              fromAddress: msg.envelope?.from?.[0]?.address ?? "unknown",
              repliedAt: new Date(),
            })
            if (noted) matched++
          }

          // (2) Thread the inbound email into a Message (best-effort; never abort the
          //     poll on a single malformed message).
          if (msg.source) {
            try {
              const parsed = await parseInboundEmail(msg.source)
              if (parsed) await recordInboundEmailMessage(tenantId, parsed)
            } catch (e) {
              console.error("[inbound-poll] failed to thread email into a Message", e)
              // continue: one bad message must not stop the sweep
            }
          }
        }
      } finally {
        lock.release()
      }

      return { ok: true, checked, matched }
    } finally {
      // connect() succeeded, so the socket is open regardless of what happens
      // above — a bad status/fetch must not leak it.
      await client.logout().catch(() => {})
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : "IMAP poll failed"
    return { ok: false, message: redactSecrets(raw, [config.imapPass, openedPass]) }
  }
}

async function pollMsGraph(config: InboundPollConfig, tenantId: string): Promise<InboundPollResult> {
  try {
    if (!config.tenantAzureId || !config.clientId || !config.clientSecret) {
      return { ok: false, message: "MS Graph config incomplete" }
    }

    // Same restriction as the IMAP path (pollImap → assertInboundHostAllowed),
    // but Graph has no "host" to check against an allowlist — it always talks
    // to Microsoft's own endpoints — so the only available guard is the
    // blanket delivery-mode switch. Checked before any request is made.
    if (!isUnrestricted()) {
      return {
        ok: false,
        message: "Graph inbound polling is disabled in this environment (EMAIL_DELIVERY_MODE is not unrestricted).",
      }
    }

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${config.tenantAzureId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.clientId,
          client_secret: openField(config.clientSecret),
          scope: "https://graph.microsoft.com/.default",
        }),
      }
    )
    const tokenData = await tokenRes.json()
    const access_token = tokenData?.access_token
    if (!tokenRes.ok || !access_token) {
      return { ok: false, message: `Graph token request failed (HTTP ${tokenRes.status})` }
    }

    const msgsRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${config.fromAddress}/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime desc&$select=id,subject,from,toRecipients,internetMessageId,internetMessageHeaders,body,receivedDateTime`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    )
    if (!msgsRes.ok) {
      return { ok: false, message: `Graph inbox request failed (HTTP ${msgsRes.status})` }
    }
    const msgsData = await msgsRes.json()
    const messages = msgsData.value ?? []

    let matched = 0
    for (const msg of messages) {
      const refHeader = msg.internetMessageHeaders?.find((h: { name: string }) => h.name === "X-Lms-Ref")
      const loanRef = refHeader?.value
      if (!loanRef) continue

      const noted = await recordEmailReply(tenantId, {
        loanId: loanRef,
        subject: msg.subject ?? "(no subject)",
        fromAddress: msg.from?.emailAddress?.address ?? "unknown",
        repliedAt: new Date(msg.receivedDateTime),
      })
      if (noted) matched++
    }

    // Thread the inbound email into a Message (best-effort; never abort the
    // poll on a single malformed message). Mirrors the pollImap path above.
    for (const msg of messages) {
      try {
        const parsed = mapGraphMessage(msg as GraphMessage)
        if (parsed) await recordInboundEmailMessage(tenantId, parsed)
      } catch (e) {
        console.error("[inbound-poll] failed to thread email into a Message", e)
        // continue: one bad message must not stop the sweep
      }
    }

    return { ok: true, checked: messages.length, matched }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Graph poll failed" }
  }
}

/**
 * IMAP login check — connects, NOOPs, reads the INBOX status and disconnects.
 * Deliberately separate from testEmailConfig (lib/email/service.ts:548), which
 * SENDS a message: an operator debugging dead inbound needs to know the mailbox
 * login works without emitting mail, and an SMTP success says nothing about
 * whether IMAP is reachable — the two use different ports and often different
 * credentials.
 *
 * The returned message is operator-facing and MUST NOT contain a credential:
 * some IMAP servers echo the attempted login into the error string.
 */
export async function testImapLogin(tenantId: string): Promise<{ ok: boolean; message: string }> {
  const config = await prisma.emailConfig.findUnique({ where: { tenantId } })
  if (!config) return { ok: false, message: "No email config found" }
  if (!config.imapHost || !config.imapUser || !config.imapPass) {
    return { ok: false, message: "IMAP config incomplete — set host, username and password first." }
  }

  const result = await runImapLoginCheck({
    host: config.imapHost,
    port: config.imapPort ?? 993,
    user: config.imapUser,
    pass: config.imapPass,
    secrets: [config.imapPass],
  })

  try {
    await prisma.emailConfig.update({
      where: { tenantId },
      data: { lastImapTestedAt: new Date(), lastImapTestOk: result.ok },
    })
  } catch (e) {
    console.error("[inbound-poll] failed to persist IMAP test result", { tenantId }, e)
  }

  return result
}

type ImapLoginCheck = { host: string; port: number; user: string; pass: string; secrets: string[] }

async function runImapLoginCheck(check: ImapLoginCheck): Promise<{ ok: boolean; message: string }> {
  try {
    assertInboundHostAllowed(check.host)
  } catch (e) {
    if (e instanceof InboundHostBlockedError) return { ok: false, message: e.message }
    throw e
  }

  let pass: string
  try {
    pass = openField(check.pass)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not read the stored IMAP password" }
  }

  const { ImapFlow } = await import("imapflow")
  const client = new ImapFlow({
    host: check.host,
    port: check.port,
    secure: true,
    auth: { user: check.user, pass },
    logger: false,
  })

  try {
    await client.connect()
    try {
      await client.noop()
      const status = await client.status("INBOX", { messages: true })
      return { ok: true, message: `Connected to ${check.host} — INBOX has ${status.messages ?? 0} message(s).` }
    } finally {
      // connect() succeeded, so the socket is open regardless of what happens
      // above — a bad noop/status must not leak it.
      await client.logout().catch(() => {})
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : "IMAP login failed"
    return { ok: false, message: redactSecrets(raw, [...check.secrets, pass]) }
  }
}

/** Some IMAP servers echo the attempted credential back in the error. Strip
 * any value we know is a secret before it reaches a screen or an audit row.
 * Longest-first: a shorter secret that happens to be a substring of a longer
 * one (e.g. a truncated retry password) must not leave a partial fragment
 * unredacted after the longer one is removed. */
function redactSecrets(message: string, secrets: (string | null | undefined)[]): string {
  return [...secrets]
    .filter((s): s is string => Boolean(s))
    .sort((a, b) => b.length - a.length)
    .reduce((acc, secret) => acc.split(secret).join("[redacted]"), message)
}
