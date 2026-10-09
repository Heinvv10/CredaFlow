import Link from "next/link"
import { Phone } from "lucide-react"
import { cn } from "@/lib/utils"
import { getScoreTier } from "@/lib/lead-scoring"

// A flat, priority-ordered "who to call next" view across every open stage —
// the complement to the stage-column board. Ordered by score × staleness
// (see leadQueuePriority) so high-value leads going cold rise to the top.

export type QueueLead = {
  id: string
  firstName: string
  lastName: string
  phone: string
  source: string
  status: string
  score: number
  updatedAt: Date
  activityCount: number
  tags: string[]
}

// Website insurance enquiries arrive as ordinary WEBSITE leads (LeadSource is a
// channel, not a product), so without the tag an adviser cannot tell one from a
// loan enquiry and picks up the call with the wrong script.
export const INSURANCE_ENQUIRY_TAG = "insurance-enquiry"

const COVER_LABELS: Record<string, string> = {
  motor: "Vehicle",
  home: "Home",
  contents: "Contents",
  other: "Unspecified",
}

export function insuranceCoverLabel(tags: string[]): string | null {
  const tag = tags.find((t) => t.startsWith("cover:"))
  if (!tag) return null
  return COVER_LABELS[tag.slice("cover:".length)] ?? null
}

const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "Manual",
  WEBSITE: "Website",
  REFERRAL: "Referral",
  WALK_IN: "Walk-in",
  SOCIAL: "Social",
  WHATSAPP: "WhatsApp",
}

const STAGE_LABELS: Record<string, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  PROPOSAL_SENT: "Proposal Sent",
}

const TIER_TONE: Record<string, string> = {
  HOT: "border-red-500/40 bg-red-500/12 text-red-200",
  WARM: "border-amber-500/40 bg-amber-500/12 text-amber-200",
  COOL: "border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.12)] text-[var(--cf-brand-soft)]",
  COLD: "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] text-[var(--cf-text-muted)]",
}

function daysSince(date: Date) {
  // Clamp negatives — a lead updated at request time (or minor app/DB clock
  // skew) must never render "idle -1d".
  return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000))
}

function Staleness({ updatedAt }: { updatedAt: Date }) {
  const days = daysSince(updatedAt)
  const tone =
    days <= 1
      ? "text-[var(--cf-text-muted)]"
      : days <= 3
        ? "text-amber-300"
        : "text-red-300"
  return (
    <span className={cn("flex items-center gap-1 text-[11px] font-medium", tone)}>
      {days > 1 && (
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", days <= 3 ? "bg-amber-400" : "bg-red-400")} />
      )}
      idle {days}d{days > 3 && " · stale"}
    </span>
  )
}

export function LeadWorkQueue({
  leads,
  insuranceOnly = false,
  insuranceCount = 0,
}: {
  leads: QueueLead[]
  insuranceOnly?: boolean
  insuranceCount?: number
}) {
  return (
    <div className="min-w-0 space-y-5">
      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">
          CRM Pipeline
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--cf-text)]">
              {insuranceOnly ? "Insurance enquiries" : "Work queue"}
            </h1>
            <p className="mt-1 text-sm text-[var(--cf-text-muted)]">
              {leads.length} open {leads.length === 1 ? "lead" : "leads"}
              {insuranceOnly ? " · short-term insurance enquiries" : " · who to contact next, by score & staleness"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Server-side filter via searchParams so this component stays
                presentational and the list is not shipped to the browser twice. */}
            <Link
              href={insuranceOnly ? "/crm/leads/queue" : "/crm/leads/queue?filter=insurance"}
              className="rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] px-3 py-1.5 text-sm text-[var(--cf-text-secondary)] transition-colors hover:border-[var(--cf-border-strong)]"
            >
              {insuranceOnly ? "Show all leads" : `Insurance only${insuranceCount ? ` (${insuranceCount})` : ""}`}
            </Link>
            <Link
              href="/crm/leads"
              className="rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] px-3 py-1.5 text-sm text-[var(--cf-text-secondary)] transition-colors hover:border-[var(--cf-border-strong)]"
            >
              ← Board view
            </Link>
          </div>
        </div>
      </div>

      {leads.length === 0 ? (
        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-8 text-center text-sm text-[var(--cf-text-muted)]">
          {insuranceOnly
            ? "No open insurance enquiries — none have come in yet, or they are all converted or lost."
            : "No open leads to work — everything is converted, lost, or nothing has come in yet."}
        </div>
      ) : (
        <ol className="overflow-hidden rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)]">
          {leads.map((lead, i) => {
            const tier = getScoreTier(lead.score)
            return (
              <li
                key={lead.id}
                className={cn(
                  "flex items-center gap-3 px-4 py-3",
                  i > 0 && "border-t border-[var(--cf-border-subtle)]",
                  i === 0 && "bg-[rgba(79,70,229,0.06)]",
                )}
              >
                <span className="w-6 flex-shrink-0 text-center text-[12px] tabular-nums text-[var(--cf-text-muted)]">
                  {i + 1}
                </span>
                <div
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                  style={{ background: "linear-gradient(135deg, #4338CA 0%, #4F46E5 100%)" }}
                >
                  {lead.firstName[0]}
                  {lead.lastName[0]}
                </div>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/crm/leads/${lead.id}`}
                    className="text-[13px] font-semibold text-[var(--cf-text)] transition-colors hover:text-[var(--cf-brand-soft)]"
                  >
                    {lead.firstName} {lead.lastName}
                  </Link>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--cf-text-muted)]">
                    <Phone className="h-3 w-3" />
                    {lead.phone}
                    <span className="text-[var(--cf-border-strong)]">·</span>
                    {SOURCE_LABELS[lead.source] ?? lead.source}
                    <span className="text-[var(--cf-border-strong)]">·</span>
                    {STAGE_LABELS[lead.status] ?? lead.status}
                    {lead.tags.includes(INSURANCE_ENQUIRY_TAG) && (
                      <>
                        <span className="text-[var(--cf-border-strong)]">·</span>
                        <span
                          data-testid="insurance-enquiry-badge"
                          className="rounded border border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.14)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--cf-brand-soft)]"
                        >
                          Insurance
                          {insuranceCoverLabel(lead.tags) ? ` · ${insuranceCoverLabel(lead.tags)}` : ""}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <span className="flex-shrink-0 tabular-nums text-[13px] font-bold text-[var(--cf-brand-soft)]">
                  {lead.score}
                </span>
                <span className={cn("flex-shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold", TIER_TONE[tier.label])}>
                  {tier.label}
                </span>
                <span className="w-24 flex-shrink-0 text-right">
                  <Staleness updatedAt={lead.updatedAt} />
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
