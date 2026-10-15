import Link from "next/link"
import { notFound } from "next/navigation"
import { requireOperatorPage } from "@/lib/operator/console-auth"
import { getOperatorLender } from "@/lib/operator/console/lenders"
import { findActiveSupportGrant } from "@/lib/operator/support-grants"
import { OperatorPageTitle } from "@/components/operator/OperatorShell"
import { TenantStatusBadge } from "@/components/operator/TenantStatusBadge"
import { LenderStatusControl } from "@/components/operator/LenderStatusControl"
import { LenderAdminReset } from "@/components/operator/LenderAdminReset"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatDate, formatDateTime } from "@/lib/utils"

export const dynamic = "force-dynamic"

const FEATURE_LABELS: Record<string, string> = {
  featureLms: "Loans", featureCrm: "CRM", featureIms: "Insurance", featureBureauSubmission: "Bureau submission",
  featureMarketing: "Marketing", featurePortal: "Client portal", featureReports: "Reports", featureAssetFinance: "Asset finance",
}

export default async function OperatorLenderPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireOperatorPage()
  const { id } = await params
  const lender = await getOperatorLender(principal.operatorId, id)
  if (!lender) notFound()
  const grant = await findActiveSupportGrant(lender.id, principal.id)
  const isAdmin = principal.role === "OPERATOR_ADMIN"

  return (
    <>
      <OperatorPageTitle
        title={lender.name}
        subtitle={`${lender.slug}${lender.domain ? ` · ${lender.domain}` : ""} · created ${formatDate(lender.createdAt)}`}
        actions={<TenantStatusBadge status={lender.status} />}
      />
      <div className="grid gap-4 md:grid-cols-3">
        <Stat label="Active loans" value={String(lender.activeLoans)} />
        <Stat label="Clients" value={String(lender.clients)} />
        <Stat label="Last staff sign-in" value={lender.lastActivityAt ? formatDateTime(lender.lastActivityAt) : "—"} />
      </div>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">Support access</CardTitle></CardHeader>
        <CardContent className="text-sm text-[var(--cf-text-secondary)]">
          {grant ? (
            <p>
              This lender has granted you read-only support access until {formatDateTime(grant.expiresAt)}.{" "}
              <Link href={`/operator/lenders/${lender.id}/support`} className="font-medium text-[var(--cf-brand-alt)] hover:underline">Open lender (read-only)</Link>
            </p>
          ) : (
            <p>You hold no active support grant for this lender. Its ADMIN grants access under Settings → Support access.</p>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">Branding and modules</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-[var(--cf-text-secondary)]">Brand name: <span className="text-[var(--cf-text)]">{lender.brandName ?? "—"}</span></p>
          {lender.colours ? (
            <div className="flex gap-3">
              {Object.entries(lender.colours).map(([k, v]) => (
                <span key={k} className="inline-flex items-center gap-2 text-xs text-[var(--cf-text-muted)]">
                  <span className="h-4 w-4 rounded border border-[var(--cf-border-subtle)]" style={{ background: v }} />{v}
                </span>
              ))}
            </div>
          ) : null}
          <p className="text-[var(--cf-text-secondary)]">
            Modules on: {Object.entries(lender.features).filter(([, on]) => on).map(([k]) => FEATURE_LABELS[k] ?? k).join(", ") || "none"}
          </p>
        </CardContent>
      </Card>

      {isAdmin ? (
        <>
          <LenderStatusControl tenantId={lender.id} status={lender.status} />
          <LenderAdminReset tenantId={lender.id} admins={lender.admins.map((a) => ({ ...a, lastLoginAt: a.lastLoginAt ? formatDateTime(a.lastLoginAt) : null }))} />
        </>
      ) : null}
      <p className="mt-4 text-sm"><Link href={`/operator/usage`} className="text-[var(--cf-brand-alt)] hover:underline">Usage and billing counts →</Link></p>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wide text-[var(--cf-text-muted)]">{label}</p>
      <p className="mt-1 text-xl font-semibold text-[var(--cf-text)] tabular-nums">{value}</p>
    </Card>
  )
}
