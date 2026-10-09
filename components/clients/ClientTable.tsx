"use client"

import Link from "next/link"
import { Eye, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatZAR } from "@/lib/utils"
import { getStatusTone } from "@/lib/status-style"

interface Client {
  id: string
  reference: string
  firstName: string
  lastName: string
  idNumber: string
  email: string
  phone: string
  kycStatus: string
  monthlyIncome: number
  createdAt: Date
  _count: {
    loans: number
    applications: number
  }
}

interface ClientTableProps {
  clients: Client[]
}

function getInitials(first: string, last: string) {
  return (first[0] + last[0]).toUpperCase()
}

export function ClientTable({ clients }: ClientTableProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)]">
      <div className="flex items-center justify-between border-b border-[var(--cf-border-subtle)] px-6 py-4">
        <div>
          <h3 className="text-sm font-semibold text-[var(--cf-text)]">All Clients</h3>
          <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">{clients.length} registered</p>
        </div>
        <Button asChild size="sm">
          <Link href="/clients/new">
            <Plus className="h-4 w-4" />
            New Client
          </Link>
        </Button>
      </div>
      {clients.length === 0 ? (
        <div className="p-12 text-center text-sm text-[var(--cf-text-muted)]">No clients registered yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)]">
                {["Ref", "Client", "ID Number", "Contact", "Income / Month", "KYC", "Activity", ""].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--cf-text-muted)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr
                  key={client.id}
                  className="border-b border-[var(--cf-border-subtle)] transition-colors hover:bg-[rgba(79,70,229,0.06)]"
                >
                  <td className="px-4 py-3 font-mono text-xs text-[var(--cf-text-muted)]">{client.reference}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.14)] text-[11px] font-semibold text-[var(--cf-brand-soft)]">
                        {getInitials(client.firstName, client.lastName)}
                      </div>
                      <p className="text-[13px] font-semibold text-[var(--cf-text)]">
                        {client.firstName} {client.lastName}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--cf-text-secondary)]">{client.idNumber}</td>
                  <td className="px-4 py-3">
                    <p className="text-[13px] text-[var(--cf-text-secondary)]">{client.email}</p>
                    <p className="mt-0.5 text-[11px] text-[var(--cf-text-muted)]">{client.phone}</p>
                  </td>
                  <td className="px-4 py-3 font-medium text-[var(--cf-text)]">{formatZAR(client.monthlyIncome)}</td>
                  <td className="px-4 py-3">
                    <Badge variant={getStatusTone(client.kycStatus)}>{client.kycStatus}</Badge>
                  </td>
                  <td className="px-4 py-3 text-[12px] text-[var(--cf-text-muted)]">
                    {client._count.loans} loan{client._count.loans !== 1 ? "s" : ""} / {client._count.applications} app{client._count.applications !== 1 ? "s" : ""}
                  </td>
                  <td className="px-4 py-3">
                    <Button asChild variant="ghost" size="icon" className="h-8 w-8">
                      <Link href={`/clients/${client.id}`}>
                        <Eye className="h-4 w-4" />
                      </Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
