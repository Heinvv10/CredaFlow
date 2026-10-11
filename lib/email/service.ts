/**
 * Email Service — supports MS Graph API and IMAP/SMTP
 * Reads config from DB (EmailConfig) per tenant
 */

import { prisma } from "@/lib/prisma"
import nodemailer from "nodemailer"
import { randomUUID } from "node:crypto"
import { htmlToPlainText } from "@/lib/email/html-to-text"
import { blockedMessage, checkRecipient } from "./recipient-guard"
import { openField } from "./secrets"
import { smtpFailedBeforeConnection } from "./smtp-failure"

export interface EmailAttachment {
  filename: string
  content: Buffer
  contentType: string
  // If set, the attachment is inline and referenced from the HTML body via
  // `cid:<cid>` (e.g. <img src="cid:signature">). Used for embedded
  // letterhead images. Omit for regular file attachments (PDFs).
  cid?: string
}

export interface SendEmailOptions {
  tenantId: string
  to: string
  toName?: string
  subject: string
  html: string
  text?: string
  category?: string
  referenceId?: string
  listUnsubscribeUrl?: string
  // Body-secrecy. When set, the EmailLog row stores THIS string in
  // bodyHtml/bodyText instead of the real body, while the provider still
  // receives the true body. Set by the messaging pipeline for templates
  // flagged `redactStoredBody` — a live OTP, password-reset code or tokenised
  // signing link must not sit in plaintext in a table that /api/email/logs
  // exposes to ADMIN and that anyone with DB read can select.
  redactedBodyPlaceholder?: string
  // Reply-To header. Used by Section 129 / collections sends to route
  // replies to collections@ while keeping the technical From (noreply@)
  // for SPF/DKIM alignment with the SMTP auth user.
  replyTo?: string
  // File + inline attachments. Inline ones must set `cid`.
  attachments?: EmailAttachment[]
  // RFC 5322 threading headers. `inReplyTo` is the Message-ID of the message
  // being replied to; `references` is the whole thread chain (each id wrapped
  // in angle brackets). Set by the inbox reply path so the customer's mail
  // client keeps the conversation threaded.
  inReplyTo?: string
  references?: string[]
  // Compliance workflows use this exact boundary to distinguish preparation
  // failures from an ambiguous external delivery attempt.
  onProviderDispatchStart?: () => void
  // Shared deadline signal supplied by the durable Message dispatch lease.
  // Graph fetches consume it directly; SMTP closes its transport on abort.
  signal?: AbortSignal
  // The durable Message reservation records the provider selected before the
  // provider boundary. Refuse a mid-request config flip instead of sending via
  // a provider that contradicts that audit record.
  expectedProvider?: EmailDispatchProvider
}

export type EmailProviderOutcome = "ACCEPTED" | "DEFINITELY_REJECTED" | "AMBIGUOUS"
export type EmailDispatchProvider = "MSGRAPH" | "SMTP"

export interface EmailResult {
  ok: boolean
  provider?: EmailDispatchProvider
  messageId?: string
  providerEvidenceReference?: string
  error?: string
  providerOutcome: EmailProviderOutcome
  /** Instant the provider positively accepted the submission. */
  acceptedAt?: Date
  /** Auxiliary EmailLog failure; provider evidence above remains authoritative. */
  emailLogPersistenceError?: string
}

function persistenceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Graph can return a timeout/conflict after accepting sendMail. Restrict
// automatic replay to endpoint responses that prove the request was rejected.
const GRAPH_DEFINITE_REJECTION_STATUSES = new Set([
  400, 401, 403, 404, 405, 413, 415, 422, 429,
])

export function graphHttpFailureOutcome(
  status: number,
): "DEFINITELY_REJECTED" | "AMBIGUOUS" {
  return GRAPH_DEFINITE_REJECTION_STATUSES.has(status)
    ? "DEFINITELY_REJECTED"
    : "AMBIGUOUS"
}

function isDefiniteSmtpRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const responseCode = (error as { responseCode?: unknown }).responseCode
  return typeof responseCode === "number" && responseCode >= 400 && responseCode <= 599
}

// ── MS Graph ────────────────────────────────────────────────────────────────

async function sendViaGraph(
  config: {
    tenantAzureId: string
    clientId: string
    clientSecret: string
    fromAddress: string
    fromName: string
  },
  opts: SendEmailOptions
): Promise<EmailResult> {
  let sendMailStarted = false
  const clientRequestId = randomUUID()
  try {
    // 1. Get OAuth2 token
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${config.tenantAzureId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          scope: "https://graph.microsoft.com/.default",
        }),
        signal: opts.signal,
      }
    )
    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      return { ok: false, error: `Graph token error: ${err}`, providerOutcome: "DEFINITELY_REJECTED" }
    }
    const { access_token } = await tokenRes.json()

    // 2. Send mail via Graph sendMail
    opts.onProviderDispatchStart?.()
    sendMailStarted = true
    const mailRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${config.fromAddress}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
          // Graph sendMail returns no message id. A unique client request id,
          // echoed alongside Graph's request-id when available, is therefore
          // the durable provider-support correlation for this exact POST.
          "client-request-id": clientRequestId,
          "return-client-request-id": "true",
        },
        body: JSON.stringify({
          message: {
            subject: opts.subject,
            body: {
              contentType: "HTML",
              content: opts.html,
            },
            toRecipients: [
              {
                emailAddress: {
                  address: opts.to,
                  name: opts.toName ?? opts.to,
                },
              },
            ],
            from: {
              emailAddress: {
                address: config.fromAddress,
                name: config.fromName,
              },
            },
            internetMessageHeaders: [
              { name: "X-Lms-Category", value: opts.category ?? "general" },
              { name: "X-Lms-Ref", value: opts.referenceId ?? "" },
              // No In-Reply-To/References here: threaded replies are rejected for
              // MS Graph upstream in sendEmail (synthetic Message-ID can't thread).
              ...(opts.listUnsubscribeUrl
                ? [
                    { name: "List-Unsubscribe", value: `<${opts.listUnsubscribeUrl}>` },
                    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
                  ]
                : []),
            ],
            ...(opts.replyTo
              ? { replyTo: [{ emailAddress: { address: opts.replyTo } }] }
              : {}),
            ...(opts.attachments && opts.attachments.length > 0
              ? {
                  attachments: opts.attachments.map((a) => ({
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    name: a.filename,
                    contentType: a.contentType,
                    contentBytes: a.content.toString("base64"),
                    ...(a.cid ? { contentId: a.cid, isInline: true } : {}),
                  })),
                }
              : {}),
          },
          saveToSentItems: true,
        }),
        signal: opts.signal,
      }
    )

    if (!mailRes.ok) {
      const err = await mailRes.text()
      return {
        ok: false,
        error: `Graph sendMail error: ${err}`,
        providerOutcome: graphHttpFailureOutcome(mailRes.status),
      }
    }

    const acceptedAt = new Date()
    const graphRequestId = mailRes.headers?.get?.("request-id")?.trim()
    const echoedClientRequestId = mailRes.headers?.get?.("client-request-id")?.trim()
    const acknowledgedClientRequestId = echoedClientRequestId || clientRequestId
    // Graph sendMail returns 202 with an empty body; it does not return an
    // internetMessageId. Persist request-scoped correlation, never a shared
    // status-code constant or fabricated provider id.
    return {
      ok: true,
      providerOutcome: "ACCEPTED",
      acceptedAt,
      providerEvidenceReference: graphRequestId
        ? `MSGRAPH_REQUEST_ID:${graphRequestId};CLIENT_REQUEST_ID:${acknowledgedClientRequestId}`
        : `MSGRAPH_CLIENT_REQUEST_ID:${acknowledgedClientRequestId}`,
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
      providerOutcome: sendMailStarted ? "AMBIGUOUS" : "DEFINITELY_REJECTED",
    }
  }
}

// ── SMTP ────────────────────────────────────────────────────────────────────

async function sendViaSMTP(
  config: {
    host: string
    port: number
    user: string
    pass: string
    tls: boolean
    fromAddress: string
    fromName: string
  },
  opts: SendEmailOptions
): Promise<EmailResult> {
  let sendMailStarted = false
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      requireTLS: config.tls && config.port !== 465,
      auth: { user: config.user, pass: config.pass },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
    })

    opts.onProviderDispatchStart?.()
    sendMailStarted = true
    const sendPromise = transporter.sendMail({
      from: `"${config.fromName}" <${config.fromAddress}>`,
      // Structured address, never string interpolation: a display name is
      // client-supplied data, and raw `"name" <addr>` concatenation lets a
      // crafted name smuggle additional recipients into the header.
      to: opts.toName ? { name: opts.toName, address: opts.to } : opts.to,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      // Nodemailer emits the In-Reply-To / References headers from these.
      ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
      ...(opts.references && opts.references.length > 0 ? { references: opts.references } : {}),
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      ...(opts.attachments && opts.attachments.length > 0
        ? {
            attachments: opts.attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType,
              ...(a.cid ? { cid: a.cid, contentDisposition: "inline" as const } : {}),
            })),
          }
        : {}),
      headers: {
        "X-Lms-Category": opts.category ?? "general",
        "X-Lms-Ref": opts.referenceId ?? "",
        ...(opts.listUnsubscribeUrl
          ? {
              "List-Unsubscribe": `<${opts.listUnsubscribeUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            }
          : {}),
      },
    })

    const info = opts.signal
      ? await Promise.race([
          sendPromise,
          new Promise<never>((_, reject) => {
            const abort = () => {
              transporter.close()
              reject(new Error("SMTP dispatch deadline exceeded"))
            }
            if (opts.signal!.aborted) abort()
            else opts.signal!.addEventListener("abort", abort, { once: true })
          }),
        ])
      : await sendPromise

    const messageId = typeof info.messageId === "string" ? info.messageId.trim() : ""
    if (!messageId) {
      return {
        ok: false,
        error: "SMTP returned success without a provider message id",
        providerOutcome: "AMBIGUOUS",
      }
    }
    return { ok: true, messageId, providerOutcome: "ACCEPTED", acceptedAt: new Date() }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "SMTP error",
      providerOutcome: !sendMailStarted || isDefiniteSmtpRejection(e) || smtpFailedBeforeConnection(e)
        ? "DEFINITELY_REJECTED"
        : "AMBIGUOUS",
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function sendEmail(opts: SendEmailOptions): Promise<EmailResult> {
  const config = await prisma.emailConfig.findUnique({ where: { tenantId: opts.tenantId } })

  if (!config || !config.active) {
    return { ok: false, error: "Email not configured for this tenant. Go to Settings → Email.", providerOutcome: "DEFINITELY_REJECTED" }
  }

  const provider: EmailDispatchProvider = config.provider === "MSGRAPH" ? "MSGRAPH" : "SMTP"

  // WHO may be emailed, before anything is dispatched.
  //
  // Placed here, at the ONE seam every send passes through, rather than in the
  // callers. A guard in a walkthrough that checks the loan reference proves
  // the loan is synthetic and says nothing about where that loan's mail goes,
  // so a real Section 129 statutory demand could reach a member of the public. A recipient check belongs
  // at the point of delivery, not at the point the work was requested.
  //
  // Refusals are RECORDED, not silently dropped: a blocked send that leaves no
  // trace is indistinguishable from a send that never happened, and a
  // misdirected send can go on unnoticed for months if nobody can see it.
  const recipientDecision = checkRecipient(opts.to)
  if (!recipientDecision.allowed) {
    const error = blockedMessage(opts.to, recipientDecision)
    const result: EmailResult = { ok: false, provider, error, providerOutcome: "DEFINITELY_REJECTED" }
    try {
      await prisma.emailLog.create({
        data: {
          tenantId: opts.tenantId,
          toAddress: opts.to,
          toName: opts.toName,
          subject: opts.subject,
          // Redacted the same way as the dispatched-send log below. A refusal
          // must be RECORDED — but recording it must not be the thing that
          // writes the live code to disk. `opts.text ?? htmlToPlainText(...)`
          // reconstructs the secret from the HTML, so both columns are
          // suppressed together.
          bodyHtml: opts.redactedBodyPlaceholder ?? opts.html,
          bodyText: opts.redactedBodyPlaceholder ?? (opts.text ?? htmlToPlainText(opts.html)),
          category: opts.category,
          referenceId: opts.referenceId,
          status: "BLOCKED",
          provider,
          errorMessage: error,
        },
      })
    } catch (persistError) {
      result.emailLogPersistenceError = persistenceErrorMessage(persistError)
      console.error("EmailLog persistence failed for a BLOCKED recipient", {
        tenantId: opts.tenantId,
        category: opts.category,
        referenceId: opts.referenceId,
      }, persistError)
    }
    return result
  }

  if (opts.expectedProvider && opts.expectedProvider !== provider) {
    const result: EmailResult = {
      ok: false,
      provider,
      error: `Email provider changed from ${opts.expectedProvider} to ${provider} before dispatch`,
      providerOutcome: "DEFINITELY_REJECTED",
    }
    try {
      await prisma.emailLog.create({
        data: {
          tenantId: opts.tenantId,
          toAddress: opts.to,
          toName: opts.toName,
          subject: opts.subject,
          // Same redaction as the other two EmailLog writes: this path fires
          // BEFORE dispatch, so the body it holds is the full unsent payload.
          bodyHtml: opts.redactedBodyPlaceholder ?? opts.html,
          bodyText: opts.redactedBodyPlaceholder ?? (opts.text ?? htmlToPlainText(opts.html)),
          category: opts.category,
          referenceId: opts.referenceId,
          status: "FAILED",
          provider,
          errorMessage: result.error,
        },
      })
    } catch (error) {
      result.emailLogPersistenceError = persistenceErrorMessage(error)
      console.error("EmailLog persistence failed before provider dispatch", {
        tenantId: opts.tenantId,
        provider,
        category: opts.category,
        referenceId: opts.referenceId,
      }, error)
    }
    return result
  }

  // Authoritative threading gate. A threaded reply only makes sense if the
  // OUTBOUND Message-ID we record is the real sent id (so the customer's reply
  // matches back). MS Graph returns a synthetic id (sendViaGraph), so refuse to
  // send a threaded reply over Graph rather than emit mail that can't be threaded.
  // dispatchAgentReply pre-checks the provider for a clean UX message; this is
  // the source-of-truth check that also covers a mid-request provider flip.
  if (config.provider === "MSGRAPH" && (opts.inReplyTo || (opts.references && opts.references.length > 0))) {
    return { ok: false, error: "Threaded email replies require SMTP; MS Graph threading is not supported yet.", providerOutcome: "DEFINITELY_REJECTED" }
  }

  // Apply the tenant default Reply-To (e.g. support@) for customer-facing mail,
  // unless the caller set one explicitly. EXCEPTION: Section 129 statutory
  // notices are sent with NO Reply-To by deliberate decision (a
  // From/Reply-To mismatch tripped anti-spam), so they must never inherit the
  // tenant default. When nothing applies, replies fall back to fromAddress.
  const defaultReplyTo = opts.category === "section129" ? undefined : config.replyToAddress || undefined
  const base: SendEmailOptions = { ...opts, replyTo: opts.replyTo || defaultReplyTo }

  // Ensure every HTML email carries a text/plain alternative. Multipart mail
  // avoids the HTML-only spam signal (SpamAssassin MIME_HTML_ONLY) and gives
  // plain-text clients a readable fallback. Callers that already pass their own
  // `text` (e.g. lib/notifications.ts) are left untouched. SMTP sends both parts;
  // MS Graph has no multipart body so it ignores `text` harmlessly.
  const enriched: SendEmailOptions = base.text ? base : { ...base, text: htmlToPlainText(base.html) }

  let result: EmailResult

  if (config.provider === "MSGRAPH") {
    if (!config.tenantAzureId || !config.clientId || !config.clientSecret) {
      return { ok: false, error: "MS Graph config incomplete", providerOutcome: "DEFINITELY_REJECTED" }
    }
    // Stored sealed (lib/email/secrets.ts). Tolerant read: a legacy plaintext
    // row passes through unchanged. A sealed value with no decryption key
    // throws — without this catch that propagated out of sendEmail entirely,
    // and lib/messaging/providers.ts classified the unhandled rejection as
    // AMBIGUOUS ("outcome unknown, hold for reconciliation") even though
    // nothing was ever dispatched to Graph.
    let graphClientSecret: string
    try {
      graphClientSecret = openField(config.clientSecret)
    } catch {
      return {
        ok: false,
        error: "Stored email credential could not be decrypted (check WABA_ENC_KEY)",
        providerOutcome: "DEFINITELY_REJECTED",
      }
    }
    result = await sendViaGraph(
      {
        tenantAzureId: config.tenantAzureId,
        clientId: config.clientId,
        clientSecret: graphClientSecret,
        fromAddress: config.fromAddress,
        fromName: config.fromName,
      },
      enriched
    )
  } else {
    if (!config.smtpHost || !config.smtpUser || !config.smtpPass) {
      return { ok: false, error: "SMTP config incomplete", providerOutcome: "DEFINITELY_REJECTED" }
    }
    // Same decrypt-failure handling as the Graph branch above.
    let smtpPass: string
    try {
      smtpPass = openField(config.smtpPass)
    } catch {
      return {
        ok: false,
        error: "Stored email credential could not be decrypted (check WABA_ENC_KEY)",
        providerOutcome: "DEFINITELY_REJECTED",
      }
    }
    result = await sendViaSMTP(
      {
        host: config.smtpHost,
        port: config.smtpPort ?? 587,
        user: config.smtpUser,
        pass: smtpPass,
        tls: config.useTls,
        fromAddress: config.fromAddress,
        fromName: config.fromName,
      },
      enriched
    )
  }

  result = { ...result, provider }

  // Log every attempt only after the provider result has been validated. An
  // ambiguous SMTP response is not SENT, while an id-less Graph 202 is SENT
  // with its real HTTP evidence reference.
  const status = result.providerOutcome === "ACCEPTED"
    ? "SENT" as const
    : "FAILED" as const
  const errorMessage = result.providerOutcome === "AMBIGUOUS"
    ? `[PROVIDER_OUTCOME_AMBIGUOUS] ${result.error ?? "Provider outcome requires reconciliation"}`
    : result.error
  try {
    await prisma.emailLog.create({
      data: {
        tenantId: opts.tenantId,
        toAddress: opts.to,
        toName: opts.toName,
        subject: opts.subject,
        // Redacted templates log the placeholder, never the rendered body.
        // `enriched.text` is derived from the true html, so it must be
        // suppressed on the same condition or the secret leaks via the text
        // column alone.
        bodyHtml: opts.redactedBodyPlaceholder ?? opts.html,
        bodyText: opts.redactedBodyPlaceholder ?? enriched.text,
        category: opts.category,
        referenceId: opts.referenceId,
        status,
        provider,
        messageId: result.messageId,
        providerEvidenceReference: result.providerEvidenceReference,
        sentAt: result.providerOutcome === "ACCEPTED" ? result.acceptedAt : undefined,
        errorMessage,
      },
    })
  } catch (error) {
    result.emailLogPersistenceError = persistenceErrorMessage(error)
    console.error("EmailLog persistence failed after provider result", {
      tenantId: opts.tenantId,
      provider,
      providerOutcome: result.providerOutcome,
      category: opts.category,
      referenceId: opts.referenceId,
      providerMessageId: result.messageId,
      providerEvidenceReference: result.providerEvidenceReference,
    }, error)
  }

  return result
}

// ── Test connection ──────────────────────────────────────────────────────────

export async function testEmailConfig(tenantId: string): Promise<{ ok: boolean; message: string }> {
  const config = await prisma.emailConfig.findUnique({ where: { tenantId } })
  if (!config) return { ok: false, message: "No email config found" }

  const result = await sendEmail({
    tenantId,
    to: config.fromAddress,
    toName: "Email Test",
    subject: "✅ Email config test",
    html: `<p>If you received this, your email configuration is working correctly.</p><p><b>Provider:</b> ${config.provider}</p><p><b>Time:</b> ${new Date().toISOString()}</p>`,
    text: "If you received this, your email configuration is working correctly.",
    category: "test",
  })

  // Update test timestamp
  await prisma.emailConfig.update({
    where: { tenantId },
    data: { lastTestedAt: new Date(), lastTestOk: result.ok },
  })

  return {
    ok: result.ok,
    message: result.ok ? "Test email sent successfully!" : result.error ?? "Failed",
  }
}
