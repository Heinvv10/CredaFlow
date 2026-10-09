import { prisma } from "@/lib/prisma"
import { createNotification } from "@/lib/notifications/bell"
import { sendEmail } from "@/lib/email/service"
import { escapeHtml } from "@/lib/utils"
import { requireAppBaseUrl } from "@/lib/config/deployment-urls"

const EMAIL_PREVIEW_CHARS = 500

// Staff-app base, matching lib/messaging/send.ts. A relative path is fine for
// the bell (the browser resolves it) but dead in a mail body. Exported for the
// other staff mails that link into the app (lib/website-chat/alert.ts).
export function appBaseUrl(): string {
  return requireAppBaseUrl()
}

/**
 * Bell + email for people tagged in an internal note.
 *
 * Runs AFTER the note is committed and never throws: the note is already
 * written, and a notification failure must not surface as a lost note. Each
 * recipient is handled independently so one bad address cannot silence the
 * rest of the list, and the two lookups are inside the same guarantee — a DB
 * blip reading recipients would otherwise 500 a request whose note is safely
 * on disk.
 *
 * Recipients are fanned out concurrently, but still awaited: tagging five
 * people used to add 5 × (bell + SMTP round trip) to the staffer's note POST,
 * with the composer visibly hanging. allSettled (not all) so one recipient's
 * rejection cannot abandon the others, and awaiting it keeps every failure
 * inside the catches below rather than making them invisible.
 *
 * userIds must be the resolved, tenant-checked list from resolveMentions
 * (lib/inbox/notes.ts). Nothing here re-derives or widens it.
 */
export async function notifyNoteMentions(a: {
  tenantId: string
  noteId: string
  conversationId: string
  authorName: string
  text: string
  userIds: string[]
}): Promise<void> {
  if (a.userIds.length === 0) return

  try {
    const cv = await prisma.conversation.findFirst({
      where: { id: a.conversationId, tenantId: a.tenantId },
      select: { contact: { select: { clientId: true } } },
    })
    // Any active staffer is mentionable, and a non-comms user 403s on /inbox.
    // The client page is reachable by every staff role, so prefer it.
    const clientId = cv?.contact?.clientId ?? null
    const entityType = clientId ? "Client" : "Conversation"
    const entityId = clientId ?? a.conversationId
    const path = clientId ? `/clients/${clientId}?tab=comms` : `/inbox?conversationId=${a.conversationId}`
    const url = `${appBaseUrl()}${path}`

    // tenantId is the cross-tenant boundary (User is not in
    // TENANT_SCOPED_MODELS, so nothing injects it); active repeats
    // resolveMentions' filter because a staffer deactivated between resolve and
    // fan-out would otherwise still be mailed.
    const recipients = await prisma.user.findMany({
      where: { tenantId: a.tenantId, active: true, id: { in: a.userIds } },
      select: { id: true, name: true, email: true },
    })

    // The author's name is staff-controlled and reaches a mail header here.
    // Nodemailer strips CR/LF today, but this is the one interpolation with no
    // sanitisation of its own. Not HTML-escaped — a subject is not HTML, and
    // escaping would put "&amp;" in people's inboxes.
    const subjectAuthor = a.authorName.replace(/\s+/g, " ").trim()
    const title = `${subjectAuthor} mentioned you in a note`
    const preview = a.text.slice(0, EMAIL_PREVIEW_CHARS)
    // The note text is staff-authored free text and this is the one place it
    // reaches an HTML body, so both it and the author name are escaped.
    const html = `<p>${escapeHtml(a.authorName)} mentioned you in an internal note:</p>`
      // <br> AFTER escaping, not a CSS white-space rule: Outlook 2007+ renders
      // through Word, which ignores white-space, so a multi-line note would
      // still collapse there. Safe by construction — escapeHtml has already
      // converted every < in the note, so the only markup in this string is
      // ours. (\r?\n so a CRLF paste doesn't leave a stray CR behind.)
      + `<blockquote>${escapeHtml(preview).replace(/\r?\n/g, "<br>")}</blockquote>`
      + `<p><a href="${escapeHtml(url)}">Open the thread</a></p>`

    await Promise.allSettled(recipients.map(async (r) => {
      try {
        await createNotification(
          {
            tenantId: a.tenantId,
            userId: r.id,
            type: "COMMS_MENTION",
            title,
            body: preview,
            entityType,
            entityId,
          },
          prisma.notification,
        )
      } catch (error) {
        console.error("Failed to write mention bell item:", { noteId: a.noteId, userId: r.id }, error)
      }

      try {
        // The note text travels in the body, not only a link: a mentioned
        // staffer who cannot open the thread still gets the substance.
        await sendEmail({
          tenantId: a.tenantId,
          to: r.email,
          toName: r.name ?? undefined,
          subject: title,
          html,
          text: `${a.authorName} mentioned you in an internal note:\n\n${preview}\n\n${url}`,
          category: "comms_note_mention",
          referenceId: a.noteId,
        })
      } catch (error) {
        console.error("Failed to email mention:", { noteId: a.noteId, userId: r.id }, error)
      }
    }))
  } catch (error) {
    console.error("Failed to fan out note mentions:", { noteId: a.noteId }, error)
  }
}
