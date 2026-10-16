import Link from "next/link"
import { redirect } from "next/navigation"
import { ArrowRight, Shield } from "lucide-react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TYPE_LABELS } from "@/components/insurance/wizard/constants"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { formatDate, formatZAR } from "@/lib/utils"
import { formatStatusLabel, getStatusTone } from "@/lib/status-style"
import { getPortalTenantId } from "@/lib/session-tenant"
import { getLenderIdentity } from "@/lib/config/identity"

export default async function PortalInsurancePage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const tenantId = await getPortalTenantId()
  const { tradingName, fspNumber } = await getLenderIdentity(tenantId)

  const client = await prisma.client.findFirst({
    where: { email: session.user.email, tenantId },
    select: { id: true },
  })

  if (!client) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
        <EmptyState
          icon={Shield}
          title="No client record found"
          description="This portal login is not linked to a client account yet."
          action={{ label: "Back to Overview", href: "/portal" }}
        />
      </div>
    )
  }

  const policies = await prisma.insurancePolicy.findMany({
    where: { clientId: client.id, tenantId },
    select: {
      id: true,
      policyNumber: true,
      type: true,
      status: true,
      premiumAmount: true,
      sumAssured: true,
      startDate: true,
      renewalDate: true,
      waitingPeriodEnds: true,
      policySource: true,
      insurer: true,
      insurer_rel: { select: { name: true } },
    },
    orderBy: { startDate: "desc" },
  })

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-6 md:py-8">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">Client Portal</p>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--cf-text)]">My Insurance</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--cf-text-muted)]">
          Policies held in your name, including insurance attached to a loan.{" "}
          {fspNumber
            ? <>{tradingName} is a FAIS-authorised intermediary — the insurer issues and prices the policy under its own terms.</>
            : <>The insurer issues and prices each policy under its own terms.</>}
        </p>
      </div>

      {policies.length === 0 ? (
        <EmptyState
          icon={Shield}
          title="No policies on this account yet"
          description={`Insurance taken out with ${tradingName}, including credit-life insurance attached to a loan, will appear here with premiums, cover amounts and renewal dates.`}
          action={{ label: "Back to Overview", href: "/portal" }}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {policies.map((policy) => {
            const insurerName = policy.insurer_rel?.name ?? policy.insurer ?? "Underwriter not yet recorded"
            // sumAssured is frozen at inception for bundled credit life and
            // renewalDate is the loan's maturity date (when cover ENDS), so
            // neither may be labelled as current cover or as a renewal.
            const isBundled = policy.policySource === "BUNDLED_CREDIT_AGREEMENT"
            return (
              <DataPanel
                key={policy.id}
                title={policy.policyNumber}
                description={`${TYPE_LABELS[policy.type] ?? policy.type} / ${insurerName}`}
                actions={<Badge variant={getStatusTone(policy.status)}>{formatStatusLabel(policy.status)}</Badge>}
              >
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {/* premiumAmount and sumAssured are stored in RANDS (Decimal),
                      but formatZAR expects cents — hence the * 100. Same
                      convention as the staff surfaces. */}
                  <Metric
                    label={isBundled ? "Cover at inception" : "Cover Amount"}
                    value={formatZAR(Number(policy.sumAssured) * 100)}
                  />
                  <Metric label="Monthly Premium" value={formatZAR(Number(policy.premiumAmount) * 100)} />
                  <Metric label="Started" value={formatDate(policy.startDate)} />
                  <Metric label={isBundled ? "Cover ends" : "Renews"} value={formatDate(policy.renewalDate)} />
                </div>
                {isBundled && (
                  <p className="mt-3 text-xs text-[var(--cf-text-muted)]">
                    Credit-life cover follows your outstanding loan balance, which reduces as you repay.
                  </p>
                )}
                {policy.status !== "ACTIVE" && (
                  <p className="mt-3 text-xs font-semibold text-amber-700">
                    This policy is not in force — the amounts above are its last recorded terms.
                  </p>
                )}
                {policy.waitingPeriodEnds && policy.waitingPeriodEnds > new Date() && (
                  <p className="mt-3 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] px-3 py-2 text-xs text-[var(--cf-text-muted)]">
                    Waiting period ends {formatDate(policy.waitingPeriodEnds)}. Claims before this date may not be
                    payable — check your policy terms.
                  </p>
                )}
                <div className="mt-5 flex justify-end">
                  <Button asChild size="sm">
                    <Link href={`/portal/insurance/${policy.id}`}>
                      View Policy
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </DataPanel>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--cf-text-muted)]">{label}</p>
      <p className="whitespace-nowrap mt-1 font-semibold text-[var(--cf-text)]">{value}</p>
    </div>
  )
}
