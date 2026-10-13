import { notFound } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { prisma } from "@/lib/prisma"
import { canDo } from "@/lib/auth-guards"
import { formatDate, formatDateTime } from "@/lib/utils"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { BANK_ACCOUNT_STATUS_LABELS } from "@/lib/asset-finance/asset-labels"
import { supplierBankAccountView } from "@/lib/asset-finance/supplier-bank-view"
import { BankAccountDecision } from "./BankAccountDecision"
import { BankAccountRequestForm } from "./BankAccountRequestForm"

const STATUS_TONE = {
  PENDING: "text-[var(--cf-warning)]",
  APPROVED: "text-[var(--cf-success)]",
  REJECTED: "text-[var(--cf-danger)]",
  SUPERSEDED: "text-[var(--cf-text-muted)]",
} as const

function manualNote(avsResult: unknown): string | null {
  if (typeof avsResult !== "object" || avsResult === null) return null
  const manual = (avsResult as { manualVerification?: { note?: unknown } }).manualVerification
  return typeof manual?.note === "string" ? manual.note : null
}

export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, tenantId, canManage } = await requireAssetFinanceStaffPage()
  const canDecide = canDo(user.role, "decide_asset_finance")
  const { id } = await params
  const supplier = await prisma.supplier.findFirst({
    where: { id, tenantId },
    include: { bankAccounts: { orderBy: { createdAt: "desc" } } },
  })
  if (!supplier) notFound()

  const staffIds = [...new Set(supplier.bankAccounts.flatMap((a) => [a.requestedById, a.decidedById]).filter((v): v is string => !!v))]
  const staff = await prisma.user.findMany({ where: { tenantId, id: { in: staffIds } }, select: { id: true, name: true, email: true } })
  const who = (userId: string | null) => {
    if (!userId) return "—"
    const found = staff.find((s) => s.id === userId)
    return found ? (found.name ?? found.email) : "Unknown user"
  }
  const hasApproved = supplier.bankAccounts.some((a) => a.status === "APPROVED")

  return (
    <>
      <Header
        title={supplier.name}
        subtitle={supplier.active ? "Active supplier" : "Inactive supplier"}
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Suppliers", href: "/asset-finance/suppliers" }, { label: supplier.name }]}
      />
      <div className="space-y-6 p-4 lg:p-8">
        <DataPanel title="Supplier" density="loose">
          <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-3">
            {([
              ["Registration number", supplier.registrationNumber],
              ["VAT number", supplier.vatNumber],
              ["Contact", supplier.contactName],
              ["Email", supplier.contactEmail],
              ["Phone", supplier.contactPhone],
              ["Address", supplier.address],
            ] as const).map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
                <dd className="mt-0.5 text-[var(--cf-text)]">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </DataPanel>

        <DataPanel title="Bank accounts" description="Payouts go only to the APPROVED account" density="loose">
          <div className="space-y-3">
            {supplier.bankAccounts.length === 0 && (
              <p className="text-sm text-[var(--cf-text-muted)]">No bank account captured.</p>
            )}
            {supplier.bankAccounts.map((a) => (
              <div key={a.id} className="rounded-md border border-[var(--cf-border-subtle)] p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-[var(--cf-text)]">
                    {a.bankName} · <span className="font-mono">{a.branchCode}</span> · <span className="font-mono">{supplierBankAccountView(a, user.role).accountNumber}</span>
                    {a.accountType && <span className="text-[var(--cf-text-muted)]"> · {a.accountType}</span>}
                  </p>
                  <span className={`text-xs font-semibold ${STATUS_TONE[a.status]}`}>{BANK_ACCOUNT_STATUS_LABELS[a.status]}</span>
                </div>
                <p className="mt-1 text-xs text-[var(--cf-text-muted)]">
                  Holder {a.accountHolder} · requested by {who(a.requestedById)} on {formatDate(a.createdAt)}
                  {a.decidedAt && <> · decided by {who(a.decidedById)} on {formatDateTime(a.decidedAt)}</>}
                </p>
                {a.status !== "PENDING" && manualNote(a.avsResult) && (
                  <p className="mt-1 text-xs text-[var(--cf-text-secondary)]">
                    AVS not run (no supplier AVS provider). Manual verification: {manualNote(a.avsResult)}
                  </p>
                )}
                {a.status === "PENDING" && canDecide && a.requestedById !== user.id && supplier.active && (
                  <BankAccountDecision accountId={a.id} />
                )}
                {a.status === "PENDING" && a.requestedById === user.id && (
                  <p className="mt-2 text-xs text-[var(--cf-warning)]">You requested this account; a different user must approve it.</p>
                )}
              </div>
            ))}
            {canManage && supplier.active && <BankAccountRequestForm supplierId={supplier.id} hasApproved={hasApproved} />}
          </div>
        </DataPanel>
      </div>
    </>
  )
}
