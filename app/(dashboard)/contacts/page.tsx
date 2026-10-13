import Link from "next/link"
import { Header } from "@/components/layout/Header"
import { requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { formatDateTime } from "@/lib/utils"
import { resolveContactHref, contactNeedsTriage } from "@/lib/contact/routing"
import { leadConversionState } from "@/lib/crm/lead-conversion"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { Prisma, ContactStatus } from "@prisma/client"

// Read-only Phase 9 demo. Shows Contacts. Compose / timeline / inbox is
// later — S3 onwards.

const PAGE_SIZE = 50

const STATUS_STYLES: Record<ContactStatus | "INCOMPLETE" | "STRANDED", string> = {
  UNKNOWN: "bg-amber-100 text-amber-800",
  LEAD: "bg-blue-100 text-blue-800",
  CLIENT: "bg-emerald-100 text-emerald-800",
  STAFF: "bg-purple-100 text-purple-800",
  BLOCKED: "bg-red-100 text-red-800",
  SPAM: "bg-gray-200 text-gray-700",
  DORMANT: "bg-gray-100 text-gray-700",
  MERGED: "bg-zinc-200 text-zinc-700",
  INCOMPLETE: "bg-orange-100 text-orange-800",
  STRANDED: "bg-red-100 text-red-800",
}

interface PageProps {
  searchParams: Promise<{ q?: string; page?: string }>
}

export default async function ContactsIndexPage({ searchParams }: PageProps) {
  // Page-level role guard (defence-in-depth over layout-side auth).
  // READONLY is the lowest staff tier; CLIENT/PORTAL never reaches here.
  await requireMinRole("READONLY")

  const params = await searchParams
  const q = (params.q ?? "").trim()
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1)
  const tenantId = await getStaffTenantId()

  const where: Prisma.ContactWhereInput = { tenantId }
  if (q.length > 0) {
    const orFilters: Prisma.ContactWhereInput[] = [
      { firstName: { contains: q, mode: "insensitive" } },
      { lastName: { contains: q, mode: "insensitive" } },
      { primaryEmail: { contains: q, mode: "insensitive" } },
      { primaryPhone: { contains: q } },
      { primaryWaJid: { contains: q } },
    ]
    where.OR = orFilters
  }

  const [total, contacts] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: { firstSeenAt: "desc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        primaryEmail: true,
        primaryPhone: true,
        status: true,
        clientId: true,
        leadId: true,
        firstSeenAt: true,
        // Needed to route a row straight to its record instead of the
        // intermediate identity page: the triage signal, and (for a converted
        // lead) the client it became.
        ambiguousMatchCandidates: true,
        lead: {
          select: {
            status: true,
            convertedToClientId: true,
            convertedToApplicationId: true,
            conversionRecoveryRequired: true,
          },
        },
      },
    }),
  ])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <>
      <Header title="Contacts" subtitle="Unified directory across clients, leads, and inbound channels" />
      <div className="p-6 lg:p-8 space-y-4">
        <form className="flex items-center gap-2" action="/contacts">
          <input
            type="search"
            name="q"
            placeholder="Search by name, email, phone…"
            defaultValue={q}
            className="w-full max-w-md rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
          {q.length > 0 && (
            <Link
              href="/contacts"
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              Clear
            </Link>
          )}
          <span className="ml-auto text-sm text-gray-500">
            {total} {total === 1 ? "contact" : "contacts"}
          </span>
        </form>

        <div className="rounded-md border bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Linked</TableHead>
                <TableHead>First seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-gray-500 py-8">
                    {q.length > 0 ? `No contacts match "${q}".` : "No contacts yet. Run the S2 backfill to populate."}
                  </TableCell>
                </TableRow>
              ) : (
                contacts.map((c) => {
                  const displayName = [c.firstName, c.lastName].filter((s) => s !== null && s !== "").join(" ") || "—"
                  const conversionState = c.lead
                    ? leadConversionState(
                        c.lead.status,
                        c.lead.convertedToClientId,
                        c.lead.convertedToApplicationId,
                        c.lead.conversionRecoveryRequired,
                      )
                    : null
                  const recoveryState = conversionState === "INCOMPLETE" || conversionState === "STRANDED"
                    ? conversionState
                    : null
                  const displayStatus = recoveryState ?? c.status
                  const linked: string[] = []
                  if (recoveryState !== null && c.leadId !== null) {
                    linked.push(`Lead · ${recoveryState}`)
                  } else {
                    if (c.clientId !== null) linked.push("Client")
                    if (c.leadId !== null) linked.push("Lead")
                  }
                  // Route straight to the underlying record (lead/client);
                  // only ambiguous rows fall through to the triage page.
                  const href = resolveContactHref(c)
                  const needsTriage = contactNeedsTriage(c.ambiguousMatchCandidates)
                  return (
                    <TableRow key={c.id} className="hover:bg-gray-50">
                      <TableCell>
                        <Link href={href} className="font-medium text-amber-700 hover:text-amber-900">
                          {displayName}
                        </Link>
                        {needsTriage && (
                          <Link
                            href={`/contacts/${c.id}`}
                            className="ml-2 inline-flex items-center rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 hover:bg-amber-100"
                            title="Ambiguous match — operator triage required"
                          >
                            Triage
                          </Link>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS_STYLES[displayStatus]}>{displayStatus}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-gray-700">{c.primaryEmail ?? "—"}</TableCell>
                      <TableCell className="text-sm text-gray-700">{c.primaryPhone ?? "—"}</TableCell>
                      <TableCell className="text-sm text-gray-600">{linked.length > 0 ? linked.join(" + ") : "—"}</TableCell>
                      <TableCell className="text-sm text-gray-500">{formatDateTime(c.firstSeenAt)}</TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between text-sm text-gray-600">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              {page > 1 && (
                <Link
                  href={`/contacts?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page - 1) }).toString()}`}
                  className="rounded-md border px-3 py-1 hover:bg-gray-50"
                >
                  Previous
                </Link>
              )}
              {page < totalPages && (
                <Link
                  href={`/contacts?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page + 1) }).toString()}`}
                  className="rounded-md border px-3 py-1 hover:bg-gray-50"
                >
                  Next
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
