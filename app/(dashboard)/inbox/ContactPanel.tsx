import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import type { ThreadDTO } from "./types"
import { SAST_TIME_ZONE } from "@/lib/utils"

export function ContactPanel({ thread }: { thread: ThreadDTO }) {
  const c = thread.contact
  const w = thread.window
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto border-l border-gray-200 bg-gray-50 p-4 text-sm">
      <div>
        <h3 className="font-semibold text-gray-900">{c.displayName}</h3>
        <Badge className="mt-1 bg-gray-200 text-gray-700">{c.status}</Badge>
      </div>
      <dl className="space-y-1 text-gray-700">
        {c.primaryPhone && <div><dt className="text-gray-400">Phone</dt><dd>{c.primaryPhone}</dd></div>}
        {c.primaryWaJid && <div><dt className="text-gray-400">WhatsApp</dt><dd className="break-all">{c.primaryWaJid}</dd></div>}
        {c.primaryEmail && <div><dt className="text-gray-400">Email</dt><dd>{c.primaryEmail}</dd></div>}
      </dl>

      {c.waOptedOut && (
        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800">
          Customer has opted out of WhatsApp (STOP). Replies will be blocked by consent.
        </div>
      )}

      {/* The 24h window is a WhatsApp-only rule, so it shows whenever this
          contact can be replied to on WhatsApp — NOT on conversation.channel,
          which is only the channel the thread was opened on. A thread opened
          by email that later carries WhatsApp reminders still has a window. */}
      {thread.reply.availableChannels.includes("WHATSAPP") && (
        <div className={`rounded-md px-3 py-2 text-xs ${w.open ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "bg-gray-100 text-gray-600 border border-gray-200"}`}>
          {w.open
            ? `24h reply window open${w.expiresAt ? ` · closes ${new Date(w.expiresAt).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })}` : ""}`
            : "24h reply window closed — a template may be required"}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase text-gray-400">Linked</p>
        {c.clientId && <Link href={`/clients/${c.clientId}`} className="block text-amber-700 hover:underline">Client profile →</Link>}
        {thread.linked.loan && <Link href={`/loans/${thread.linked.loan.id}`} className="block text-amber-700 hover:underline">Loan {thread.linked.loan.reference} ({thread.linked.loan.status}) →</Link>}
        {thread.linked.application && <Link href={`/applications/${thread.linked.application.id}`} className="block text-amber-700 hover:underline">Application {thread.linked.application.reference} →</Link>}
        {!c.clientId && !thread.linked.loan && !thread.linked.application && <p className="text-xs text-gray-400">No linked records.</p>}
      </div>
    </div>
  )
}
