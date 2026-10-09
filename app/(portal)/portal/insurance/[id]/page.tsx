import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { ArrowLeft, FileText, Users } from "lucide-react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TYPE_LABELS } from "@/components/insurance/wizard/constants"
import { PprAcknowledgementCard } from "@/components/portal/PprAcknowledgementCard"
import { clientViewableDisclosureDocumentId } from "@/lib/insurance/disclosure-access"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { formatDate, formatZAR } from "@/lib/utils"
import { formatStatusLabel, getStatusTone } from "@/lib/status-style"
import { getDefaultTenantId } from "@/lib/tenant"
import { getLenderIdentity } from "@/lib/config/identity"

export default async function PortalPolicyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const tenantId = await getDefaultTenantId()
  const { tradingName } = await getLenderIdentity(tenantId)

  const client = await prisma.client.findFirst({
    where: { email: session.user.email, tenantId },
    select: { id: true },
  })
  if (!client) notFound()

  // Scoped by clientId AND tenantId: a policy belonging to another client is
  // indistinguishable from one that does not exist.
  const policy = await prisma.insurancePolicy.findFirst({
    where: { id, clientId: client.id, tenantId },
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
      linkedLoanId: true,
      policySource: true,
      insurer: true,
      insurer_rel: { select: { name: true, fspNumber: true } },
      product: { select: { name: true } },
      faisDisclosurePdfUrl: true,
      pprIssuedAt: true,
      pprAcknowledgedAt: true,
      beneficiaries: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          relationship: true,
          coverAmount: true,
        },
      },
    },
  })
  if (!policy) notFound()

  const linkedLoan = policy.linkedLoanId
    ? await prisma.loan.findFirst({
        where: { id: policy.linkedLoanId, clientId: client.id, tenantId },
        select: { id: true, reference: true },
      })
    : null

  const insurerName = policy.insurer_rel?.name ?? policy.insurer ?? null
  const typeLabel = TYPE_LABELS[policy.type] ?? policy.type
  // For a bundled policy sumAssured is frozen at the loan principal on the day
  // of disbursement (disburse/route.ts writes it once and nothing updates it),
  // while credit life actually indemnifies the OUTSTANDING balance. Calling
  // that "Cover Amount" overstates cover for every client who has repaid
  // anything. renewalDate is likewise the loan's maturity date — the day cover
  // ENDS, not a renewal.
  const isBundled = policy.policySource === "BUNDLED_CREDIT_AGREEMENT"
  const coverIsInForce = policy.status === "ACTIVE"
  const disclosureDocumentId = clientViewableDisclosureDocumentId(policy.faisDisclosurePdfUrl)

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-6 md:py-8">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2">
          <Link href="/portal/insurance">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to My Insurance
          </Link>
        </Button>
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">{typeLabel}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-[var(--cf-text)]">{policy.policyNumber}</h1>
          <Badge variant={getStatusTone(policy.status)}>{formatStatusLabel(policy.status)}</Badge>
        </div>
        <p className="mt-1 text-sm text-[var(--cf-text-muted)]">
          {insurerName ? (
            <>
              Underwritten by {insurerName}
              {policy.insurer_rel?.fspNumber ? ` (FSP ${policy.insurer_rel.fspNumber})` : ""}
            </>
          ) : (
            "Underwriter not yet recorded — contact us for your policy details"
          )}
          {policy.product?.name ? ` / ${policy.product.name}` : ""}
        </p>
      </div>

      {!coverIsInForce && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-semibold">This policy is not in force</p>
          <p className="mt-0.5 text-xs text-amber-700">
            Its status is {formatStatusLabel(policy.status).toLowerCase()}. The amounts below are the last recorded
            terms and do not represent cover you currently hold.
          </p>
        </div>
      )}

      <DataPanel title="Cover and premium">
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          {/* RANDS in the DB, cents in formatZAR — see the * 100 note on the list page. */}
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
            Credit-life cover follows the outstanding balance of your loan, which reduces as you repay. The figure
            above is the amount covered when the policy started, not your current balance.
          </p>
        )}
        {policy.waitingPeriodEnds && (
          <p className="mt-4 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] px-3 py-2 text-xs text-[var(--cf-text-muted)]">
            {policy.waitingPeriodEnds > new Date()
              ? `Waiting period ends ${formatDate(policy.waitingPeriodEnds)}. Claims before this date may not be payable — check your policy terms.`
              : `Waiting period ended ${formatDate(policy.waitingPeriodEnds)}.`}
          </p>
        )}
        {policy.policySource === "BUNDLED_CREDIT_AGREEMENT" && (
          <p className="mt-3 text-xs text-[var(--cf-text-muted)]">
            This insurance is attached to your credit agreement.
            {linkedLoan ? (
              <>
                {" "}
                <Link
                  href={`/portal/loans/${linkedLoan.id}`}
                  className="font-semibold text-[var(--cf-brand)] underline underline-offset-2"
                >
                  View loan {linkedLoan.reference}
                </Link>
              </>
            ) : null}
          </p>
        )}
      </DataPanel>

      <DataPanel
        title="Beneficiaries"
        description="Who would receive the benefit. To change a beneficiary, contact us."
      >
        {policy.beneficiaries.length === 0 ? (
          <div className="flex items-center gap-3 text-sm text-[var(--cf-text-muted)]">
            <Users className="h-4 w-4 shrink-0" />
            <span>No beneficiaries recorded on this policy.</span>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--cf-border-subtle)]">
            {policy.beneficiaries.map((b) => (
              <li key={b.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                <div>
                  <p className="text-sm font-medium text-[var(--cf-text)]">
                    {b.firstName} {b.lastName}
                  </p>
                  <p className="text-xs text-[var(--cf-text-muted)]">{b.relationship}</p>
                </div>
                {b.coverAmount != null && (
                  <p className="whitespace-nowrap text-sm font-semibold text-[var(--cf-text)]">
                    {formatZAR(Number(b.coverAmount) * 100)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </DataPanel>

      <DataPanel title="Documents and disclosures">
        <div className="space-y-3 text-sm">
          {/* Only a /api/documents/<id>/view url is client-openable. A standalone
              policy's disclosure url is a staff-only, one-hour-TTL endpoint, so
              rendering "View" for it would hand the client a guaranteed 403. */}
          {disclosureDocumentId ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] px-3 py-2.5">
              <div className="flex items-center gap-3">
                <FileText className="h-4 w-4 shrink-0 text-[var(--cf-brand-soft)]" />
                <span className="text-[var(--cf-text)]">FAIS disclosure</span>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={policy.faisDisclosurePdfUrl!} target="_blank" rel="noopener noreferrer">
                  View
                </Link>
              </Button>
            </div>
          ) : (
            <p className="text-[var(--cf-text-muted)]">
              Your FAIS disclosure for this policy is not available online. Contact us and we will send you a copy.
            </p>
          )}

          <PprAcknowledgementCard
            policyId={policy.id}
            disclosureUrl={disclosureDocumentId ? policy.faisDisclosurePdfUrl : null}
            issued={policy.pprIssuedAt !== null}
            acknowledgedAt={policy.pprAcknowledgedAt ? formatDate(policy.pprAcknowledgedAt) : null}
          />
        </div>
      </DataPanel>

      <p className="text-xs leading-6 text-[var(--cf-text-muted)]">
        {tradingName} is a FAIS-authorised intermediary. The insurer named above issues and prices this policy under
        its own terms; claims are assessed by the insurer. If you are unhappy with how a policy or claim has been
        handled, you may escalate through our complaints process and onward to the FAIS Ombud.
      </p>
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
