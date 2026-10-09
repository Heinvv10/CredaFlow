import type { MessageTemplate } from "@prisma/client"
import type { RenderedTemplate } from "./render"

/**
 * What a staff member sees on the comms timeline in place of a secret-bearing
 * body. It is deliberately a fixed, non-reversible string — not a mask of the
 * real value — so no part of the code or link survives in the Message row.
 */
export const REDACTED_BODY_PLACEHOLDER =
  "[redacted — contains a one-time code or signing link]"

/**
 * The body to PERSIST for a send. For an ordinary template this is the
 * rendered body unchanged; for a template flagged `redactStoredBody` it is the
 * placeholder.
 *
 * Only the stored copy changes. The caller still dispatches the TRUE rendered
 * body to the provider, and still fingerprints the TRUE payload — the
 * fingerprint is the evidence-integrity anchor and must not be weakened by
 * redaction, otherwise two different OTP emails would fingerprint identically
 * and the idempotency check could no longer tell one request from another.
 *
 * Subject is NOT redacted: templates put the code in the body, and a redacted
 * subject would leave the timeline row unidentifiable.
 */
export function storedBodyFor(
  template: Pick<MessageTemplate, "redactStoredBody">,
  rendered: RenderedTemplate,
): RenderedTemplate {
  if (!template.redactStoredBody) return rendered
  return {
    subject: rendered.subject,
    text: REDACTED_BODY_PLACEHOLDER,
    // Preserve null-ness: a text-only template must not gain an HTML body.
    html: rendered.html === null ? null : REDACTED_BODY_PLACEHOLDER,
  }
}
