import { notFound, redirect } from "next/navigation"
import { PrintButton } from "@/components/applications/PrintButton"
import { Header } from "@/components/layout/Header"
import { loadCommitteePack } from "@/lib/approval/pack"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireMinRole } from "@/lib/auth-guards"
import { activeCurrency } from "@/lib/jurisdiction/active"
import { formatMoney } from "@/lib/jurisdiction/money"
import { canDo } from "@/lib/permissions"
import { getStaffTenantId } from "@/lib/session-tenant"

export const metadata = { title: "Credit committee pack" }

const date = (iso: string | null) => (iso ? iso.slice(0, 10) : "not recorded")
const yesNo = (v: boolean) => (v ? "Yes" : "No")

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="break-inside-avoid space-y-2 rounded-lg border border-[var(--cf-border-subtle)] p-4 print:border-gray-300">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">{title}</h2>
      {children}
    </section>
  )
}
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="flex justify-between gap-4 text-sm"><dt className="text-[var(--cf-text-secondary)]">{label}</dt><dd className="text-right font-medium">{value}</dd></div>
}

/** The credit committee pack: everything the committee needs on one application, printable. Personal data: viewing it is audited. */
export default async function CommitteePackPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireMinRole("LOAN_ADMIN")
  if (!canDo(user.role, "view_committee_pack")) redirect("/applications")
  const { id } = await params
  const tenantId = await getStaffTenantId()
  const pack = await loadCommitteePack({ tenantId, applicationId: id, viewer: { id: user.id, role: user.role } })
  if (!pack) notFound()
  await logAuditStrict({ tenantId, userId: user.id, userEmail: user.email, action: AuditAction.COMMITTEE_PACK_VIEWED, entity: "LoanApplication", entityId: id, newValue: { reference: pack.application.reference } })
  const currency = activeCurrency()
  const money = (cents: number | null) => (cents === null ? "not recorded" : formatMoney(cents, currency))
  const a = pack.application
  const ap = pack.approval
  return (
    <>
      <Header
        title={`Credit committee pack · ${a.reference}`}
        subtitle={`Prepared ${pack.generatedAt.slice(0, 16).replace("T", " ")} UTC for the credit committee. Confidential: contains personal information.`}
        breadcrumbs={[{ label: "Applications", href: "/applications" }, { label: a.reference, href: `/applications/${a.id}` }, { label: "Committee pack" }]}
      />
      <div className="mx-auto max-w-4xl space-y-4 p-4 lg:p-8">
        <div className="flex justify-end"><PrintButton /></div>
        <Section title="Application">
          <dl className="space-y-1">
            <Row label="Reference" value={a.reference} />
            <Row label="Status" value={a.status} />
            <Row label="Product" value={a.productName} />
            <Row label="Amount applied for" value={money(a.appliedAmountCents)} />
            <Row label="Term" value={`${a.termDays} days`} />
            <Row label="Purpose" value={a.purpose ?? "not recorded"} />
            <Row label="Branch" value={a.branchName ?? "not recorded"} />
            <Row label="Submitted" value={`${date(a.submittedAt)}${a.channel ? ` (${a.channel === "PORTAL" ? "by the client" : "captured by staff"})` : ""}`} />
          </dl>
        </Section>
        {pack.client && (
          <Section title="Applicant">
            <dl className="space-y-1">
              <Row label="Name" value={pack.client.name} />
              <Row label="ID number" value={pack.client.idNumberMasked} />
              <Row label="Employment" value={`${pack.client.employmentStatus ?? "not recorded"}${pack.client.employerName ? `, ${pack.client.employerName}` : ""}`} />
              <Row label="Monthly income (net)" value={money(pack.client.monthlyIncomeCents)} />
              <Row label="Monthly expenses" value={money(pack.client.monthlyExpensesCents)} />
              <Row label="KYC" value={pack.client.kycStatus} />
            </dl>
          </Section>
        )}
        <Section title="Affordability">
          <dl className="space-y-1">
            <Row label="Net disposable income" value={money(pack.affordability.netDisposableIncomeCents)} />
            <Row label="After this loan's instalment" value={money(pack.affordability.ndiAfterLoanCents)} />
            <Row label="Existing monthly debt" value={money(pack.affordability.totalExistingDebtCents)} />
          </dl>
        </Section>
        <Section title="Credit bureau">
          {pack.bureau ? (
            <dl className="space-y-1">
              <Row label="Checked" value={`${date(pack.bureau.checkedAt)} (${pack.bureau.provider})`} />
              <Row label="Score / grade" value={`${pack.bureau.score ?? "none"} / ${pack.bureau.riskGrade ?? "none"}${pack.bureau.unscoreable ? " (unscoreable)" : ""}`} />
              <Row label="Adverse information" value={yesNo(pack.bureau.adverse)} />
              <Row label="Judgement" value={yesNo(pack.bureau.judgement)} />
              <Row label="Notice (e.g. sequestration)" value={yesNo(pack.bureau.notice)} />
              <Row label="Under debt review" value={yesNo(pack.bureau.underDebtReview)} />
              <Row label="Deceased" value={yesNo(pack.bureau.deceased)} />
            </dl>
          ) : <p className="text-sm text-[var(--cf-text-muted)]">No bureau check on file.</p>}
        </Section>
        <Section title="Score and risk grade">
          <dl className="space-y-1">
            <Row label="Risk grade" value={pack.score.grade ?? "not graded"} />
            <Row label="Score" value={pack.score.score ?? "not scored"} />
            <Row label="Pricing tier" value={pack.score.pricingTier ?? "none"} />
          </dl>
          {pack.engineRuns.length > 0 && (
            <ul className="space-y-1 pt-2 text-xs">
              {pack.engineRuns.map((r) => <li key={r.at}>{date(r.at)} · {r.mode} · verdict {r.verdict} ({r.reasonCodes.join(", ") || "no codes"}) · {r.execution}</li>)}
            </ul>
          )}
        </Section>
        <Section title="History with the lender">
          <p className="text-sm">{pack.history.loans.length} loan{pack.history.loans.length === 1 ? "" : "s"}; {pack.history.otherApplications} other application{pack.history.otherApplications === 1 ? "" : "s"}.</p>
          {pack.history.loans.length > 0 && <ul className="space-y-1 text-xs">{pack.history.loans.map((l) => <li key={l.reference}>{l.reference} · {l.status} · {money(l.principalCents)} · since {date(l.since)}</li>)}</ul>}
        </Section>
        <Section title="Approval chain">
          {ap.applies ? (
            <>
              <p className="text-sm">{ap.requiredLevels === 0 ? "No staff approval chain required." : `${ap.requiredLevels} level(s) required`}{ap.matchedRules.length > 0 ? `, because of: ${ap.matchedRules.map((r) => r.name).join(", ")}` : ""} (matrix {ap.matrixName} v{ap.matrixVersion}).</p>
              <ol className="space-y-1 text-sm">
                {ap.levels.map((l) => <li key={l.level}>Level {l.level}, {l.name}: <strong>{l.state === "APPROVED" ? `approved by ${l.approvedBy} on ${date(l.approvedAt)}${l.via === "DELEGATION" ? " (delegated)" : ""}` : l.state === "NOT_REQUIRED" ? "not needed" : "awaiting"}</strong></li>)}
              </ol>
            </>
          ) : <p className="text-sm text-[var(--cf-text-muted)]">No approval matrix applies.</p>}
        </Section>
        <Section title="Committee decisions and conditions">
          {ap.committeeDecisions.length === 0 ? <p className="text-sm text-[var(--cf-text-muted)]">No decision recorded yet.</p> : (
            <ul className="space-y-3 text-sm">
              {ap.committeeDecisions.map((d) => (
                <li key={d.id}>
                  <strong>{d.decision}</strong> on {d.meetingDate}, recorded by {d.recordedBy}. Present: {d.attendees.join(", ")}.
                  <div className="text-[var(--cf-text-secondary)]">{d.rationale}</div>
                  {d.conditions.length > 0 && <ul className="list-disc pl-6">{d.conditions.map((c) => <li key={c}>{c}</li>)}</ul>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  )
}
