import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { PortalDebitMandateClient } from "./PortalDebitMandateClient"

export default async function PortalDebitMandatePage({
  params,
}: {
  params: Promise<{ applicationId: string }>
}) {
  const session = await auth()
  if (!session?.user?.email || session.user.role !== "CLIENT") {
    redirect("/portal/login")
  }
  const { applicationId } = await params
  const tenantId = await getDefaultTenantId()
  const application = await prisma.loanApplication.findUnique({
    where: { id: applicationId, tenantId },
    select: {
      id: true,
      reference: true,
      status: true,
      repaymentMethod: true,
      agreementSignedAt: true,
      debitMandatePreparedAt: true,
      debitMandateDraftSha256: true,
      debitMandateSignedAt: true,
      client: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          bankName: true,
          bankBranchCode: true,
          bankAccountNumber: true,
          accountType: true,
        },
      },
    },
  })
  if (
    !application
    || application.client.id !== session.user.id
    || application.client.email !== session.user.email
  ) {
    redirect("/portal")
  }
  if (
    application.status !== "APPROVED"
    || application.repaymentMethod !== "DEBIT_ORDER"
    || !application.agreementSignedAt
  ) {
    redirect(`/portal/applications/${application.id}`)
  }

  return (
    <PortalDebitMandateClient
      applicationId={application.id}
      reference={application.reference}
      clientName={`${application.client.firstName} ${application.client.lastName}`}
      initialBankDetails={{
        bankName: application.client.bankName ?? "",
        branchCode: application.client.bankBranchCode ?? "",
        accountNumber: application.client.bankAccountNumber ?? "",
        // This form offers only the two types a DEBIT ORDER can carry, because
        // the Netcash AVS wire has no third value. Anything else on the client
        // record prefills as CHEQUE and the consumer corrects it before
        // signing.
        //
        // Two records reach that fallback, and neither is a mistake:
        //   - TRANSMISSION, retired 2026-08-05, inert, none in any environment.
        //   - OTHER, added 2026-08-13, which is EFT-only for exactly the same
        //     reason this form is CHEQUE/SAVINGS-only.
        //
        // An OTHER client reaches this page more easily than an earlier draft
        // of this comment claimed. That draft said it required staff to set
        // OTHER AFTER a debit-order application existed. Not so: nothing screens
        // Client.accountType when an application is approved onto DEBIT_ORDER
        // (app/api/applications/[id]/decide/route.ts takes repaymentMethod from
        // the form and never looks at the account type), so an ALREADY-OTHER
        // client can be approved straight onto a debit order — which then
        // dead-ends at requireDebitMandateBankDetails with a message about
        // incomplete banking details, for a client whose details are complete
        // and merely OTHER. Barring that combination belongs at approval, not
        // on this form.
        //
        // Submitting the form then
        // writes the chosen type back to the client record
        // (app/api/applications/[id]/debit-mandate/route.ts), reversing the
        // staff decision. That is safe rather than alarming, because the same
        // route first requires the submitted tuple to match a verified
        // statement: a consumer can only move the record to a value the
        // statement actually supports, and the write is audited with
        // source: "customer_debit_mandate". It is still a staff decision being
        // undone by a consumer, so if that combination becomes common the fix
        // is to bar the page, not to widen this form.
        accountType:
          application.client.accountType === "SAVINGS" ? "SAVINGS" : "CHEQUE",
      }}
      initialDraftSha256={
        application.debitMandatePreparedAt
          ? application.debitMandateDraftSha256
          : null
      }
      initiallySigned={application.debitMandateSignedAt !== null}
    />
  )
}
