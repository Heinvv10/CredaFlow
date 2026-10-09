import { notFound } from "next/navigation"
import Link from "next/link"
import { Header } from "@/components/layout/Header"
import { requireMinRole, hasMinRole } from "@/lib/auth-guards"
import { logAudit } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { formatDateTime } from "@/lib/utils"
import { isAmbiguousMatchPayload } from "@/lib/contact/routing"
import { leadConversionState, leadPipelineStatus } from "@/lib/crm/lead-conversion"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { ContactStatus, Channel } from "@prisma/client"
import { AlertTriangle, Mail, Phone, MessageCircle } from "lucide-react"

// Phase 9 S1 demo deliverable — read-only Contact detail. No compose, no
// timeline (S3), no claim (S5/S6). Operators see backfilled rows so they
// can verify the migration before downstream cutover.

const STATUS_STYLES: Record<ContactStatus, string> = {
  UNKNOWN: "bg-amber-100 text-amber-800",
  LEAD: "bg-blue-100 text-blue-800",
  CLIENT: "bg-emerald-100 text-emerald-800",
  STAFF: "bg-purple-100 text-purple-800",
  BLOCKED: "bg-red-100 text-red-800",
  SPAM: "bg-gray-200 text-gray-700",
  DORMANT: "bg-gray-100 text-gray-700",
  MERGED: "bg-zinc-200 text-zinc-700",
}

const CHANNEL_ICON: Partial<Record<Channel, typeof Mail>> = {
  EMAIL: Mail,
  SMS: Phone,
  VOICE: Phone,
  WHATSAPP: MessageCircle,
}

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ContactDetailPage({ params }: PageProps) {
  const { id } = await params
  // Page-level role guard. READONLY is the lowest staff role; CLIENT never
  // reaches here. The ambiguous-match panel below is gated separately at
  // LOAN_ADMIN because it surfaces third-party PII from collision candidates.
  const user = await requireMinRole("READONLY")
  const tenantId = await getDefaultTenantId()

  const contact = await prisma.contact.findFirst({
    where: { id, tenantId },
    include: {
      client: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          idNumber: true,
          email: true,
          phone: true,
          createdAt: true,
        },
      },
      lead: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          status: true,
          convertedToClientId: true,
          convertedToApplicationId: true,
          conversionRecoveryRequired: true,
          createdAt: true,
        },
      },
    },
  })
  if (!contact) notFound()

  const identities = await prisma.contactIdentity.findMany({
    where: { tenantId, contactId: contact.id },
    orderBy: [{ channel: "asc" }, { createdAt: "asc" }],
  })

  const displayName = [contact.firstName, contact.lastName].filter((s) => s !== null && s !== "").join(" ") || "(no name)"

  const ambiguous = isAmbiguousMatchPayload(contact.ambiguousMatchCandidates)
    ? contact.ambiguousMatchCandidates
    : null
  const leadConversion = contact.lead
    ? leadConversionState(
        contact.lead.status,
        contact.lead.convertedToClientId,
        contact.lead.convertedToApplicationId,
        contact.lead.conversionRecoveryRequired,
      )
    : null
  const leadStatus = contact.lead
    ? leadPipelineStatus(
        contact.lead.status,
        contact.lead.convertedToClientId,
        contact.lead.convertedToApplicationId,
        contact.lead.conversionRecoveryRequired,
      )
    : null
  const ambiguousClients = ambiguous?.clients ?? []
  const ambiguousLeads = ambiguous?.leads ?? []
  const hasAmbiguousCandidates = ambiguousClients.length > 0 || ambiguousLeads.length > 0

  // The ambiguous-match panel exposes third-party PII (the candidate Client
  // and Lead names + identifiers) so only LOAN_ADMIN+ can see the details.
  // Lower-role staff see a "review required" hint without candidate data
  // (POPIA s.10 minimality — surface only what triage role actually needs).
  const canSeeAmbiguousCandidates = hasMinRole(user.role, "LOAN_ADMIN")

  // Audit-log the privileged reveal (POPIA s.17 accountability). The plain
  // Contact detail view is not logged — that's consistent with /clients/[id]
  // which only audits document access; the cross-customer reveal is the
  // unique privacy surface here.
  if (hasAmbiguousCandidates && canSeeAmbiguousCandidates) {
    await logAudit({
      tenantId,
      userId: user.id,
      userEmail: user.email,
      action: "CONTACT_AMBIGUOUS_PANEL_VIEWED",
      entity: "Contact",
      entityId: contact.id,
      newValue: {
        candidateClientCount: ambiguousClients.length,
        candidateLeadCount: ambiguousLeads.length,
      },
    })
  }

  // Resolve ambiguous candidate names so the triage list is readable. Only
  // fetch if the viewer is authorised; otherwise the panel renders a generic
  // "review required" message.
  const [ambiguousClientRows, ambiguousLeadRows] = canSeeAmbiguousCandidates
    ? await Promise.all([
        ambiguousClients.length > 0
          ? prisma.client.findMany({
              where: { tenantId, id: { in: ambiguousClients } },
              select: { id: true, firstName: true, lastName: true, email: true },
            })
          : Promise.resolve([]),
        ambiguousLeads.length > 0
          ? prisma.lead.findMany({
              where: { tenantId, id: { in: ambiguousLeads } },
              select: { id: true, firstName: true, lastName: true, email: true, phone: true },
            })
          : Promise.resolve([]),
      ])
    : [[], []]

  return (
    <>
      <Header
        title={displayName}
        subtitle={`Contact · ${contact.status.toLowerCase()}`}
        breadcrumbs={[
          { label: "Contacts", href: "/contacts" },
          { label: displayName },
        ]}
      />
      <div className="p-6 lg:p-8 space-y-6 max-w-5xl">
        {/* Header card */}
        <section className="rounded-md border bg-white p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-2xl font-semibold text-gray-900">{displayName}</div>
              <div className="mt-1">
                <Badge className={STATUS_STYLES[contact.status]}>{contact.status}</Badge>
              </div>
            </div>
            <div className="text-right text-sm text-gray-500">
              <div>First seen: {formatDateTime(contact.firstSeenAt)}</div>
              <div>Channel: {contact.firstSeenChannel}</div>
              {contact.firstSeenContext !== null && (
                <div className="font-mono text-xs">{contact.firstSeenContext}</div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-gray-500 mb-1">Email</div>
              <div className="text-gray-900">{contact.primaryEmail ?? "—"}</div>
            </div>
            <div>
              <div className="text-gray-500 mb-1">Phone</div>
              <div className="text-gray-900">{contact.primaryPhone ?? "—"}</div>
            </div>
            <div>
              <div className="text-gray-500 mb-1">WhatsApp JID</div>
              <div className="text-gray-900 font-mono text-xs">{contact.primaryWaJid ?? "—"}</div>
            </div>
          </div>
        </section>

        {/* Ambiguous match panel — operator triage signal */}
        {hasAmbiguousCandidates && (
          <section className="rounded-md border border-amber-300 bg-amber-50 p-6 space-y-3">
            <div className="flex items-center gap-2 text-amber-900">
              <AlertTriangle className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Ambiguous match — operator triage required</h2>
            </div>
            <p className="text-sm text-amber-800">
              The S2 backfill detected a shared identity between this Contact and other Client/Lead records.
              No identity row was written for the shared value(s). Resolve by linking this Contact to the
              correct record, or by confirming the candidates are distinct people.
            </p>
            {!canSeeAmbiguousCandidates && (
              <p className="text-sm text-amber-700">
                {ambiguousClients.length + ambiguousLeads.length} candidate{ambiguousClients.length + ambiguousLeads.length === 1 ? "" : "s"} flagged.
                Ask a loan administrator to review.
              </p>
            )}
            {canSeeAmbiguousCandidates && ambiguousClientRows.length > 0 && (
              <div>
                <div className="text-sm font-medium text-amber-900 mb-1">Candidate clients</div>
                <ul className="text-sm space-y-1">
                  {ambiguousClientRows.map((c) => (
                    <li key={c.id}>
                      <Link href={`/clients/${c.id}`} className="text-amber-900 hover:underline">
                        {c.firstName} {c.lastName}
                      </Link>
                      <span className="text-amber-700"> · {c.email}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {canSeeAmbiguousCandidates && ambiguousLeadRows.length > 0 && (
              <div>
                <div className="text-sm font-medium text-amber-900 mb-1">Candidate leads</div>
                <ul className="text-sm space-y-1">
                  {ambiguousLeadRows.map((l) => (
                    <li key={l.id}>
                      <Link href={`/crm/leads/${l.id}`} className="text-amber-900 hover:underline">
                        {l.firstName} {l.lastName}
                      </Link>
                      <span className="text-amber-700">
                        {" "}
                        · {l.email ?? l.phone}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* Linked Client */}
        {contact.client !== null && (
          <section className="rounded-md border bg-white p-6 space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Linked client</h2>
              <Link
                href={`/clients/${contact.client.id}`}
                className="text-sm font-medium text-amber-700 hover:text-amber-900"
              >
                Open client →
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-gray-500">Name: </span>
                <span className="text-gray-900">{contact.client.firstName} {contact.client.lastName}</span>
              </div>
              <div>
                <span className="text-gray-500">ID number: </span>
                <span className="text-gray-900 font-mono">{contact.client.idNumber}</span>
              </div>
              <div>
                <span className="text-gray-500">Email: </span>
                <span className="text-gray-900">{contact.client.email}</span>
              </div>
              <div>
                <span className="text-gray-500">Phone: </span>
                <span className="text-gray-900">{contact.client.phone}</span>
              </div>
              <div className="sm:col-span-2 text-xs text-gray-500">
                Created {formatDateTime(contact.client.createdAt)}
              </div>
            </div>
          </section>
        )}

        {/* Linked Lead */}
        {contact.lead !== null && (
          <section className="rounded-md border bg-white p-6 space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Linked lead</h2>
              <Link
                href={`/crm/leads/${contact.lead.id}`}
                className="text-sm font-medium text-amber-700 hover:text-amber-900"
              >
                Open lead →
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-gray-500">Name: </span>
                <span className="text-gray-900">{contact.lead.firstName} {contact.lead.lastName}</span>
              </div>
              <div>
                <span className="text-gray-500">Status: </span>
                <span className="text-gray-900">{leadStatus}</span>
              </div>
              <div>
                <span className="text-gray-500">Email: </span>
                <span className="text-gray-900">{contact.lead.email ?? "—"}</span>
              </div>
              <div>
                <span className="text-gray-500">Phone: </span>
                <span className="text-gray-900">{contact.lead.phone}</span>
              </div>
              {leadConversion === "COMPLETE" && contact.lead.convertedToClientId !== null && (
                <div className="sm:col-span-2 text-xs text-gray-500">
                  Converted to client {contact.lead.convertedToClientId} via application {contact.lead.convertedToApplicationId}
                </div>
              )}
              {(leadConversion === "INCOMPLETE" || leadConversion === "STRANDED") && (
                <div className="sm:col-span-2 text-xs font-medium text-amber-700">
                  Conversion recovery required — this lead is not a completed conversion.
                </div>
              )}
              <div className="sm:col-span-2 text-xs text-gray-500">
                Created {formatDateTime(contact.lead.createdAt)}
              </div>
            </div>
          </section>
        )}

        {/* Identities */}
        <section className="rounded-md border bg-white">
          <div className="px-6 pt-6 pb-2">
            <h2 className="text-lg font-semibold text-gray-900">Identities</h2>
            <p className="text-sm text-gray-500">
              All known channel/value pairs the inbound matcher uses to route messages to this Contact.
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Verified</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {identities.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-gray-500 py-6">
                    No identity rows. This Contact will not be matched by inbound messages until at least one is added.
                  </TableCell>
                </TableRow>
              ) : (
                identities.map((ident) => {
                  const Icon = CHANNEL_ICON[ident.channel]
                  return (
                    <TableRow key={ident.id}>
                      <TableCell>
                        <span className="inline-flex items-center gap-2 text-sm text-gray-700">
                          {Icon !== undefined && <Icon className="h-4 w-4 text-gray-500" />}
                          {ident.channel}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-gray-900">{ident.value}</TableCell>
                      <TableCell>
                        {ident.verified ? (
                          <Badge className="bg-emerald-100 text-emerald-800">Verified</Badge>
                        ) : (
                          <Badge className="bg-gray-100 text-gray-700">Unverified</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-gray-600">{ident.source}</TableCell>
                      <TableCell className="text-sm text-gray-500">{formatDateTime(ident.createdAt)}</TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </section>
      </div>
    </>
  )
}
