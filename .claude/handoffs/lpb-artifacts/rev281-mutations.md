# PR 281 mutations, head 4bb24c42: 73 code mutants run (41 killed, 32 survived); 8 trigger mutants NOT run

id | mutation | result | killed by
--|--|--|--
P1 | row.totalPaid >= row.totalDue -> row.totalPaid > row.totalDue | KILLED | lib/loan-changes/plan.test.ts > planInPlace > keeps paid rows untouched and reschedules only the unpaid princi
P2 | const interestDue = Math.min(row.interestDue, paid)     const feesDue -> const interestDue = 0     const feesDue | KILLED | lib/loan-changes/plan.test.ts > planInPlace > splits a part-paid row that fell due on what the receipts paid: 
P3 | const principalDue = Math.min(row.principalDue, paid) -> const principalDue = 0 | KILLED | lib/loan-changes/plan.test.ts > planInPlace > money paid ahead on a row not yet due lowers the balance: it is 
P4 | sastDay(row.dueDate) <= today -> sastDay(row.dueDate) < today | SURVIVED | IT: 
P5 | Math.max(0, (row.carriedInterestDue ?? 0) - paid.interestDue) -> (row.carriedInterestDue ?? 0) | SURVIVED | IT: 
P6 | Math.max(0, (row.carriedFeesDue ?? 0) - paid.feesDue) -> (row.carriedFeesDue ?? 0) | SURVIVED | IT: 
P7 | (settled(row) \|\| isDue(row)) && row.dueDate > latest -> isDue(row) && row.dueDate > latest | KILLED | lib/loan-changes/plan.test.ts > planInPlace > keeps a fully prepaid future row and starts after it
P8 | Math.round(balance * periodRate) * target.holiday -> Math.round(balance * periodRate * target | SURVIVED | IT: 
P9 | Math.round((target.holiday * PERIOD_DAYS[frequency]) / 30) * loan.mont -> target.holiday * loan.monthlyServiceFee | SURVIVED | IT: 
P10 | const periodRate = frequency === "MONTHLY" ? target.rate : (target.rat -> const periodRate = target.rate | SURVIVED | IT: 
P11 | Math.round((balance * target.rate * gapDays) / 30) -> Math.round((balance * target.rate * gapD | KILLED | lib/loan-changes/plan.test.ts > planInPlace > a reschedule moves the first date and charges the extra days as 
P12 | gapDays < 0 \|\| sastDay -> sastDay | KILLED | lib/loan-changes/plan.test.ts > planInPlace > refuses a reschedule to before the next instalment
P13 | sastDay(target.firstDueDate) <= today -> sastDay(target.firstDueDate) < today | SURVIVED | IT: 
P14 | settled(row) \|\| row.totalPaid > 0 ? row.installmentNo -> settled(row) ? row.installmentNo | KILLED | IT: lib/loan-changes/loan-changes.integration.test.ts > loan changes in place, on a Lesotho instance (real Postgre
P15 | Math.max(1, Math.round((sastDay(lastDue) -> Math.max(2, Math.round((sastDay(lastDue) | SURVIVED | IT: 
P16 | instalments: target.instalments + target.holiday, -> instalments: target.instalments, | KILLED | lib/loan-changes/plan.test.ts > planInPlace > a payment holiday leaves the holiday's periods empty and the int
P17 | if (open.length === 0 \|\| balance <= 0) throw -> if (open.length === 0) throw | SURVIVED | IT: 
P18 | isDue(row) ? row.feesDue - paid.feesDue : -> isDue(row) ? 0 : | KILLED | lib/loan-changes/plan.test.ts > planInPlace > a due row part-paid inside its interest keeps no principal, and 
P19 | const startDate = target.holiday > 0 ? addPeriods(anchor, frequency, t -> const startDate = anchor | KILLED | lib/loan-changes/plan.test.ts > planInPlace > a payment holiday leaves the holiday's periods empty and the int
P20 | if (target.holiday > 0 && structure === "BULLET") throw -> if (false) throw | SURVIVED | IT: 
C1 | if (plan.principal > primary.product.maxAmount) throw -> if (false) throw | SURVIVED | IT: 
C2 | if (payload.instalments * PERIOD_DAYS[frequencyOf(primary)] > primary. -> if (false) throw | SURVIVED | IT: 
C3 | if (loan.clientId !== primary.clientId) throw -> if (false) throw | SURVIVED | IT: 
C4 | if (payload.type === "TOP_UP" && screening.state.state === "NOT_CONFIG -> if (false) throw | KILLED | IT: lib/loan-changes/loan-changes-new-loan.integration.test.ts > loan changes that book a new loan, on a Lesotho i
C5 | if (!screening.allowed) throw -> if (false) throw | KILLED | IT: lib/loan-changes/loan-changes-new-loan.integration.test.ts > loan changes that book a new loan, on a Lesotho i
C6 | if (figures.totalToSettle <= 0) throw -> if (false) throw | SURVIVED | IT: 
C7 |  && rows.reduce((sum, r) => sum + r.totalPaid, 0) === loan.totalPaid ->  | SURVIVED | IT: 
C8 | loan.status === "DEFAULTED" \|\| recompute -> recompute | SURVIVED | IT: 
C9 | where: { id: documentId, tenantId, clientId, deletedAt: null } -> where: { id: documentId, tenantId, delet | SURVIVED | IT: 
C10 | where: { id: documentId, tenantId, clientId, deletedAt: null } -> where: { id: documentId, tenantId, clien | SURVIVED | IT: 
C11 | refuseIneligible(loan, "NEW_LOAN")  ->   | SURVIVED | IT: 
C12 | const interestRatePm = payload.interestRatePm ?? primary.interestRateP -> const interestRatePm = primary.interestR | SURVIVED | IT: 
A1 | for (const id of [...involvedLoanIds(ctx.payload)].sort()) await lockL ->  | SURVIVED | IT: 
A2 | await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE") ->  | SURVIVED | IT: 
A3 | loan.status === "DEFAULTED" && plan.arrearsAmount === 0 ? "ACTIVE" : l -> loan.status | KILLED | IT: lib/loan-changes/loan-changes.integration.test.ts > loan changes in place, on a Lesotho instance (real Postgre
A4 | arrearsAmount: plan.arrearsAmount, daysInArrears: plan.daysInArrears,  -> arrearsAmount: plan.arrearsAmount, daysI | KILLED | IT: lib/loan-changes/loan-changes.integration.test.ts > loan changes in place, on a Lesotho instance (real Postgre
A5 | agreementDocId: payload.signedDocumentId, ...(restructured ? { restruc -> agreementDocId: payload.signedDocumentId | KILLED | IT: lib/loan-changes/loan-changes-new-loan.integration.test.ts > loan changes that book a new loan, on a Lesotho i
A6 | if (closed?.status !== "COMPLETED") throw -> if (false) throw | SURVIVED | IT: 
A7 | paidAt: loan.lastPaymentDate ?? now -> paidAt: now | SURVIVED | IT: 
A8 | FORBEARANCE_TYPES.includes(type) \|\| loans.some((loan) => inArrears(loa -> FORBEARANCE_TYPES.includes(type) | KILLED | IT: lib/loan-changes/loan-changes-new-loan.integration.test.ts > loan changes that book a new loan, on a Lesotho i
A9 | disbursedById: request.makerId -> disbursedById: checker.id | KILLED | IT: lib/loan-changes/loan-changes-guards.integration.test.ts > the database holds the rules (real Postgres, a Leso
A10 | deferredInterest: plan.deferredInterest, -> deferredInterest: 0, | SURVIVED | IT: 
A11 | if (status !== loan.status) { -> if (false) { | KILLED | IT: lib/loan-changes/loan-changes.integration.test.ts > loan changes in place, on a Lesotho instance (real Postgre
A12 | sequence: sequence + 1, productVersionId: loan.terms[0]?.productVersio -> sequence: sequence + 1, productVersionId | SURVIVED | IT: 
A13 | scheduleBefore: json([scheduleOf(loan)]) -> scheduleBefore: json([]) | KILLED | IT: lib/loan-changes/loan-changes.integration.test.ts > loan changes in place, on a Lesotho instance (real Postgre
A14 | amount: settlementCents, paymentMethod: LOAN_SETTLEMENT_METHOD -> amount: settlementCents, paymentMethod:  | KILLED | IT: lib/loan-changes/loan-changes-new-loan.integration.test.ts > loan changes that book a new loan, on a Lesotho i
A15 | contractualTotalInterest: plan.totalInterest, contractualTotalRepayabl -> maturityDate | SURVIVED | IT: 
E1 | if (loan.chargesAccrued > 0 \|\| loan.chargesOutstanding > 0) return -> if (loan.chargesOutstanding > 0) return | KILLED | lib/loan-changes/eligibility.test.ts > changeRefusal > default charges refuse a change in place, not a refinan
E2 | if (loan.collectionsStage === "ATTORNEY_REFERRED") return -> if (false) return | KILLED | lib/loan-changes/eligibility.test.ts > changeRefusal > refuses an attorney in place and into a new loan
E3 | if (loan.arrangementActive \|\| loan.paymentPlanActive) return -> if (loan.arrangementActive) return | KILLED | lib/loan-changes/eligibility.test.ts > changeRefusal > refuses a plan in place and into a new loan
E4 | if (loan.deceased) return -> if (false) return | KILLED | lib/loan-changes/eligibility.test.ts > changeRefusal > refuses a deceased borrower in place and into a new loa
E5 | loan.mandates > 0 \|\| loan.collectionInstructions > 0 -> loan.mandates > 0 | KILLED | lib/loan-changes/eligibility.test.ts > changeRefusal > refuses collection instructions in place and into a new
E6 | if (loan.debtReview) return -> if (false) return | KILLED | lib/loan-changes/eligibility.test.ts > changeRefusal > refuses debt review in place and into a new loan
E7 | if (loan.creditLifePremiums > 0) return -> if (false) return | KILLED | lib/loan-changes/eligibility.test.ts > changeRefusal > refuses credit life in place and into a new loan
E8 | if (!loan.scheduleTies) return -> if (false) return | KILLED | lib/loan-changes/eligibility.test.ts > changeRefusal > a schedule that does not tie is refused in place
E9 | loan.status !== "ACTIVE" && loan.status !== "DEFAULTED" -> loan.status !== "ACTIVE" | KILLED | lib/loan-changes/eligibility.test.ts > changeRefusal > allows a live key-facts loan, and a defaulted one
H1 | ${loan.id}:${loan.status}:${loan._count.terms} -> ${loan.id}:${loan.status} | KILLED | IT: lib/loan-changes/loan-changes.integration.test.ts > loan changes in place, on a Lesotho instance (real Postgre
H2 | ${loan.id}:${loan.status}:${loan._count.terms} -> ${loan.id}:${loan._count.terms} | SURVIVED | IT: 
V1 | const visible = mayPropose \|\| mayApprove ? requests : [] -> const visible = requests | KILLED | IT: lib/loan-changes/loan-changes.integration.test.ts > loan changes in place, on a Lesotho instance (real Postgre
V2 | documents: mayPropose ? documents : [] -> documents | KILLED | IT: lib/loan-changes/loan-changes.integration.test.ts > loan changes in place, on a Lesotho instance (real Postgre
V3 | row.status === "SUBMITTED" && row.makerId !== viewer.id && mayApprove -> row.status === "SUBMITTED" && mayApprove | SURVIVED | IT: 
R1 | if (payment.paymentMethod === LOAN_SETTLEMENT_METHOD) { -> if (false) { | KILLED | IT: lib/loan-changes/loan-changes-new-loan.integration.test.ts > loan changes that book a new loan, on a Lesotho i
R2 | if (!canDo(guard.user.role, "propose_loan_change")) return -> if (false) return | KILLED | IT: lib/loan-changes/loan-changes.integration.test.ts > loan changes in place, on a Lesotho instance (real Postgre
I1 | return !prior?.runDate \|\| prior.runDate <= restructuredOn -> return !prior?.runDate \|\| prior.runDate  | KILLED | lib/ifrs9/staging.test.ts > restructuredInForce: a live restructured loan keeps its status and carries Loan.re
I2 | prior.stage > max.stage -> prior.stage < max.stage | SURVIVED | IT: 
I3 | loan.status === "ACTIVE" && restructuredInForce -> restructuredInForce | KILLED | lib/ifrs9/snapshot.test.ts > a restructured loan (Loan.restructuredAt, lib/loan-changes) > a restructured loan
I4 | t.sequence !== 1 \|\|  ->  | SURVIVED | IT: 
I5 | orderBy: { sequence: "desc" }, take: 1 -> orderBy: { sequence: "asc" }, take: 1 | SURVIVED | IT: 
K1 | p.paymentMethod === "LOAN_SETTLEMENT" ? "PAYOUT_CLEARING" : "BANK" -> "BANK" | KILLED | IT: lib/loan-changes/loan-changes-new-loan.integration.test.ts > loan changes that book a new loan, on a Lesotho i
K2 | addTo(disbursement, "PAYOUT_CLEARING", -settled) ->  | KILLED | IT: lib/loan-changes/loan-changes-new-loan.integration.test.ts > loan changes that book a new loan, on a Lesotho i
K3 | settledCents: loan.loanChangeBookedThis?.settledCents ?? 0, -> settledCents: 0, | KILLED | IT: lib/loan-changes/loan-changes-new-loan.integration.test.ts > loan changes that book a new loan, on a Lesotho i
W1 | notIn: [WAIVER_METHOD, LOAN_SETTLEMENT_METHOD] -> notIn: [WAIVER_METHOD] | KILLED | lib/collections/promiseToPay.test.ts > getPromiseToPayStatus > does not let a waived balance keep a promise
W2 | return isBalanceWaiver(method) \|\| method === LOAN_SETTLEMENT_METHOD -> return isBalanceWaiver(method) | KILLED | lib/payments/waiver.test.ts > cashReceivedCents > counts live allocated receipts only: no waivers, reversals, 
T1 | DROP TRIGGER "LoanChange_guard" ON "LoanChange" | NOAPPLY | psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role
T2 | ALTER TABLE "LoanChange" DROP CONSTRAINT "LoanChange_values" | NOAPPLY | psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role
T3 | DROP TRIGGER "LoanChange_schedule_reconciles" ON "LoanChange" | NOAPPLY | psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role
T4 | DROP TRIGGER "Payment_loan_settlement_update" ON "Payment" | NOAPPLY | psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role
T5 | DROP TRIGGER "Payment_loan_settlement_insert" ON "Payment" | NOAPPLY | psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role
T6 | DROP TRIGGER "LoanApplication_a01_guard_loan_change" ON "LoanApplication" | NOAPPLY | psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role
T7 | ALTER TABLE "LoanTerms" DROP CONSTRAINT "LoanTerms_version_or_change" | NOAPPLY | psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role
T8 | ALTER TABLE "LoanChange" DISABLE ROW LEVEL SECURITY | NOAPPLY | psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role

Unrun: T1-T8 (trigger/CHECK/RLS mutants). The runner psql role failed, so nothing was dropped; those rows say NOAPPLY, not killed.

## Reconfirm: survivors re-run at 6360672f (not rerun at e6f2ff4b)

id | mutation | result | killed by
--|--|--|--
C6 | if (figures.totalToSettle <= 0) throw -> if (false) throw | SURVIVED | IT: 
C7 |  && rows.reduce((sum, r) => sum + r.totalPaid, 0) === loan.totalPaid ->  | SURVIVED | IT: 
C8 | loan.status === "DEFAULTED" \|\| recompute -> recompute | SURVIVED | IT: 
A7 | paidAt: loan.lastPaymentDate ?? now -> paidAt: now | SURVIVED | IT: 
A10 | deferredInterest: plan.deferredInterest, -> deferredInterest: 0, | SURVIVED | IT: 
A12 | sequence: sequence + 1, productVersionId: loan.terms[0]?.productVersio -> sequence: sequence + 1, productVersionId | SURVIVED | IT: 
A15 | contractualTotalInterest: plan.totalInterest, contractualTotalRepayabl -> maturityDate | SURVIVED | IT: 
I4 | t.sequence !== 1 \|\|  ->  | SURVIVED | IT: 
P4 | sastDay(row.dueDate) <= today -> sastDay(row.dueDate) < today | SURVIVED | IT: 
P15 | Math.max(1, Math.round((sastDay(rows.at(-1)!.dueDate) -> Math.max(2, Math.round((sastDay(rows.at( | SURVIVED | IT: 
P17 | if (open.length === 0 \|\| balance <= 0) throw -> if (open.length === 0) throw | SURVIVED | IT: 

## 4bfe04d5: portal and reference mutants

id | mutation | result | killed by
--|--|--|--
F1 | clientId: session.user.id, loanChangeRequestId: null | KILLED | app/(portal)/portal/agreement/[applicationId]/page.test.ts > portal signing page — whose agreement it renders 
F2 | clientId: session.user.id, loanChangeRequestId: null | KILLED | app/(portal)/portal/mandate/[applicationId]/page.test.ts > portal debit mandate page — whose mandate it render
F3 | , OR: [{ loanChangeRequestId: null }, { status: "DISBURSED"  | SURVIVED | 
F4 | , OR: [{ loanChangeRequestId: null }, { status: "DISBURSED"  | SURVIVED | 
F5 | , loanChangeRequestId: null | KILLED | lib/portal/statement-needed.test.ts > recentStatementSince > asks nothing when no application awaits a decisio
F6 | , loanChangeRequestId: null | KILLED | app/api/portal/selfie-link/route.test.ts > POST /api/portal/selfie-link > mints a PORTAL capture link for the 
F7 |         loanChangeRequestId: null,       },       select: {  | KILLED | app/api/portal/applications/route.test.ts > POST /api/portal/applications > does not count a loan change's app
F8 |             loanChangeRequestId: null,  | SURVIVED | 
U1 | if (payload.type === "TOP_UP" && await db.loanApplication.fi | KILLED | lib/loan-changes/loan-changes-new-loan.integration.test.ts > loan changes that book a new loan, on a Lesotho i
U2 | disbursementRef: { equals: payload.payoutReference, mode: "i | KILLED | lib/loan-changes/loan-changes-new-loan.integration.test.ts > loan changes that book a new loan, on a Lesotho i
U3 | where: { tenantId, disbursementRef: { equals | SURVIVED | 

## 2624ccee: survivors re-run

F3 | , OR: [{ loanChangeRequestId: null }, { status: "DISBURSED"  | SURVIVED | 
F4 | , OR: [{ loanChangeRequestId: null }, { status: "DISBURSED"  | SURVIVED | 
F8 |             loanChangeRequestId: null,  | SURVIVED | 
U3 | where: { tenantId, disbursementRef: { equals | NOAPPLY | 
