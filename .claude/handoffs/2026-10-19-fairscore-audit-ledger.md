# Fair Score audit findings ledger (origin/main 03c1ba34; live demo afe773ca)
| # | Area | Finding | Status | PR | Test / evidence | Note |
|---|---|---|---|---|---|---|
| 1 | brand | Brand "Fairscore" vs "Fair Score"; login footer 2025 | DATA | #149 | prisma/demo-lender.test.ts (Fair Score profile) | Brand comes from TenantConfig; #147 says no hardcode; footer year is dynamic (stack clock) |
| 2 | dashboard | Demo book PAR30+ ~94%, contradicts arrears figures | DATA | #149, #138 | scripts/demo/simulate/plan.test.ts "the scripted book…"; scripts/demo/simulate/book-health.test.ts; lib/reports/book-arrears.integration.test.ts | Bake data + one PAR definition. Needs the re-bake (not yet done) to show live |
| 3 | dashboard | Logo low contrast on dark header | FIXED | #147 | components/…/shell-identity-session-tenant.test.tsx | Light padded chip around logo |
| 4 | env | Staff and portal on one host share cookies | INFO | - | - | Local-test artefact per audit; no fix found |
| 5 | portal | Loan/payment reference is raw DB id | FIXED | #152 | app/api/applications/[id]/debit-mandate/route.test.ts; app/(portal)/portal/payment/page.test.tsx | New loans only; existing keep theirs |
| 6 | portal | Documents page: identity confirmed yet selfie REQUIRED | FIXED | #152 | app/(portal)/portal/documents/PortalDocumentsClient.audit.test.tsx |  |
| 7 | portal | System-generated docs show "couldn't read" OCR message | FIXED | #152 | PortalDocumentsClient.audit.test.tsx |  |
| 8 | portal | Borrower sees Failed / Review required notification statuses | FIXED | #152 | app/(portal)/portal/notifications/page.test.tsx; lib/portal/notification-status.test.ts |  |
| 9 | portal | Payment page placeholder phone/email, "Fairscore" brand | DATA | #149 | prisma/demo-lender.test.ts | #152: page already prints TenantConfig, no code change |
| 10 | portal | Insurance page asserts FAIS-authorised claim | FIXED | #143, #149 | lib/__tests__/no-fsp-claims.test.tsx | Claim only when FSP set; demo uses fictional FSP 98765 + "Demo lender" note (Hein to confirm real FSP before market) |
| 11 | portal | Method shown "Eft"/"eft" | FIXED | #152 | lib/i18n/portal-labels.test.ts |  |
| 12 | portal | Tab title generic; no logo in portal sidebar | FIXED | #152 | portal-metadata.test.ts; PortalSidebar.logo.test.tsx; api/website/logo/route.test.ts |  |
| 13 | portal | Settled loan's application shows "Disbursed" | FIXED | #152 | lib/portal/application-view.test.ts |  |
| 14 | portal/apply | Placeholder NCR number NCRCP99999 in footer | DATA | #149 | prisma/demo-lender.test.ts; PortalApplyProductClient.test.tsx | Fictional NCRCP98765 + demo note. Real NCRCP needed before market |
| 15 | portal/apply | Credit-life box layout jump; disabled radio contradicts | FIXED | #152, #141 | PortalApplyProductClient.layout.test.tsx; PortalApplyProductClient.credit-life.test.tsx |  |
| 16 | portal/apply | Term in days; PO Funding offered to salaried nurse | FIXED | #152, #141 | PortalApplyProductClient.layout.test.tsx (months); PortalApplyProductClient.po.test.tsx; app/api/portal/applications/route.test.ts |  |
| 17 | portal/apply | Scenario panel rounding differs from top panel | FIXED | #141 | PortalApplyClient.test.tsx "to the cent" |  |
| 18 | portal/elize | Arrears banner lacks overdue amount; 27 vs 29 days | FIXED | #152 | loan-overview.test.ts; app/(portal)/portal/page.test.tsx |  |
| 19 | portal/elize | Settlement R33,877.51 exceeds outstanding (s125) | FIXED | #146 (+#157) | lib/loan/s125-settlement.test.ts "states R27,896.34 as the settlement, not R33,877.51" | Hein signed off (a)-(f) |
| 20 | portal/elize | Future instalments marked PARTIAL | FIXED | #141 | app/api/payments/bulk-upload/route.test.ts; RepaymentScheduleTable.test.tsx; schedule-status.test.ts |  |
| 21 | portal/elize | "Next installment" spelling | FIXED | #141 | lib/i18n/english-spelling.test.ts |  |
| 22 | portal/payment | Pay with Stitch shown when not configured | FIXED | #141 | app/(portal)/portal/payment/page.test.tsx; lib/stitch.test.ts |  |
| 23 | portal/payment | Notify-payment with POP works | OK | - | - | Positive observation |
| 24 | demo data | Book 14 active/9 defaulted/2 written off | DATA | #149 | scripts/demo/simulate/plan.test.ts; book-health.test.ts | Needs re-bake |
| 25 | product | Plant & Vehicle Instalment Sale productType PERSONAL | FIXED | #151 | lib/asset-finance/product-kind.integration.test.ts; prisma/seed-asset-finance.integration.test.ts | New ProductType.ASSET_FINANCE + migration |
| 26 | staff sweep | All 38 staff nav pages render | OK | - | - | Positive observation |
| 27 | staff/board | Stale pipeline ages; settled loans in DISBURSED "Waiting" | FIXED | #147, #149 | ApplicationKanban.test.tsx; simulate/seed-book.test.ts | Ages: bake data (needs re-bake); board lane: code |
| 28 | staff/app | Personal Loan 3.0% pm may exceed NCA cap | FIXED | #138 (+#157) | lib/loan/nca-interest-cap.test.ts; prisma/seed.integration.test.ts | Cap = repo+21% (GN R1080) not repo*2.2+20%; demo products now 2.25% pm. Legal to confirm Gazette. Repeat short-term 3% pm cap not implemented (policy decision) |
| 29 | staff/app | Mixed money formatting | FIXED | #147 | AffordabilityCapture.test.tsx ("R 26,492.35") |  |
| 30 | staff/app | NO_STATEMENT check blocks yet portal says docs complete | FIXED | #152 | lib/portal/statement-needed.test.ts; documents/page.test.tsx |  |
| 31 | staff/app | Selfie link panel shown for in-person verified client | FIXED | #147 | selfie-link-needed.test.ts |  |
| 32 | staff/app | "Retry Bureau Enquiry" primary after success | FIXED | #147 | bureau-rail-action.test.ts |  |
| 33 | staff/app | Update Affordability has no confirmation | FIXED | #147 | AffordabilityCapture.test.tsx |  |
| 34 | staff/app | Ticking Reckless lending shifts layout, next click unticks | FIXED | #162 | components/applications/ComplianceCapture.test.tsx | #147 changed wording only; components/applications/ComplianceCapture.tsx still renders the notes textarea conditionally on {reckless}. Portal credit-life box covered by #152 (row 15); #162: textarea always rendered, disabled until ticked. Browser 2026-10-17 OK |
| 35 | staff/app | CREDIT_OFFICER ticks NCA checks then raw Forbidden | FIXED | #139 | components/applications/ComplianceCapture.test.tsx | Controls disabled with reason |
| 36 | staff/countersign | BLOCKER countersign after mandate returns 500 | FIXED | #140 | lib/compliance/countersign-after-mandate.integration.test.ts; countersign/route.test.ts (409 not 500) | Migration 20261016200000; Browser 2026-10-19 (staging, main 03c1ba34): A1 client signed agreement 04:40 + mandate 04:41, then countersigned, no error |
| 37 | PASQ | Agreement PDF placeholder NCR, TEST credit life, R135pm | DATA | #139, #149 | prisma/seed-asset-finance.integration.test.ts (no TEST product); prisma/demo-lender.test.ts |  |
| 38 | PASQ | Portal says credit life not available, PASQ says DECLINED+offered | FIXED | #141, #142 | lib/insurance/credit-life-no-offer-threshold.integration.test.ts; lib/pdf/__tests__/creditAgreement.test.ts | PASQ prints "Not offered" (Hein signed off). Residual (a) in #141: flag-off above threshold still DECLINED |
| 39 | PASQ | Page 2 nearly blank | FIXED (PR #189 queued) | - | - | No PR mentions it; searched PR bodies 137-158, git log, lib/pdf tests; Template layout/wording change: needs Hein sign-off (NCA document) |
| 40 | credit checks | Clear-reason placeholder 15 vs counter 16 | FIXED | #147 | CreditChecksPanel.test.tsx |  |
| 41 | mandate | Bank not pre-selected; loan ref; day-of-month; no DebiCheck | FIXED (PR #189 queued; DebiCheck still GATED) | #137, #152, #162 | app/api/applications/[id]/debit-mandate/route.test.ts (loan ref) | Loan ref fixed #152. DebiCheck needs provider sandbox (docs/DEBICHECK.md). Bank preselect and "As per repayment schedule" (lib/pdf/debitMandate.ts:187) NOT addressed: mandate page seeds bank from client.bankName against fixed list, no PR touches it; Bank pre-select fixed #162 (canonicalBankName); Browser 2026-10-19 (staging, main 03c1ba34): Capitec pre-selected for Siphokazi. "Debit Day of Month" wording: Hein sign-off. DebiCheck: provider sandbox |
| 42 | portal/sign | Signing and mandate need email OTP, not in cheat sheet | DATA | #149 | scripts/demo/kits/kits.test.ts | Kit cheat sheets updated |
| 43 | recovery | Return to review works; NO BLOCKERS header; borrower not told | FIXED | #140 | lib/applications/rail-blockers.test.ts; PortalDebitMandateClient.test.tsx; mandate/page.test.ts |  |
| 44 | roles/SoD | One BRANCH_MANAGER does approve/witness/countersign/disburse | FIXED | #140 | lib/security/segregation-of-duties.integration.test.ts | Per-lender setting default ON; OFF for demo lenders; Browser 2026-10-19 (staging, main 03c1ba34): A2 SoD on: approver sees "another staff member must disburse"; POST disburse as approver -> 403 segregation_of_duties |
| 45 | staff/app | Disburse button buried mid-page | FIXED | #140 | components/applications/DisburseForm.test.tsx | Browser 2026-10-19 (staging, main 03c1ba34): A3 Loan Admin One disbursed from the decision rail; bank details locked to the signed mandate; loan LN-MVERNJ2E-CNO3 created |
| 46 | disburse | Payment reference placeholder dated April | FIXED | #140 | DisburseForm.test.tsx |  |
| 47 | OK | Thembeka returning-client loan flow end to end | OK | - | - | Positive observation |
| 48 | security | Portal accepted password "password" | FIXED | #152 | lib/security/password-policy.test.ts | >=10 chars, common-password refusal, 6 write paths |
| 49 | staff/new client | Stale validation errors until Next | FIXED | #147 | reconcile-errors.test.ts; ClientWizard.test.tsx |  |
| 50 | staff/new client | Bank name free text in staff wizard | FIXED | #147 | Step3Employment.test.tsx |  |
| 51 | staff/new app | Review copy says PASQ before approval | FIXED | #147 | wizard-copy.test.ts |  |
| 52 | staff/board | DISBURSED cards say "Waiting since today" | FIXED | #147 | ApplicationKanban.test.tsx |  |
| 53 | clients list | Every client "Client since Oct 2026" | WONTFIX | #152 | - | Not a defect: 42/55 clients have Apr-Sep createdAt; list ordered by createdAt desc (orchestrator accepted) |
| 54 | OK | Lerato new-client flow, uploads scanned | OK | - | - | Positive observation |
| 55 | portal/selfie | No camera: blank button, no phone fallback | FIXED | #152 | camera-error.test.ts; ContinueOnPhone.test.tsx; api/portal/selfie-link/route.test.ts |  |
| 56 | staff/KYC | Approve without selfie: jargon message, no path | FIXED | #147 | approval-blocked-message.test.ts; composite-kyc-copy.test.ts |  |
| 57 | OK | ADMIN in-person verification works | OK | - | - | Positive observation |
| 58 | OK | Statement insights on Lerato | OK | - | - | Positive observation |
| 59 | decline | Staff free-text shown verbatim to borrower | FIXED | #152 | decide/route.test.ts; ApplicationApprovePanel.test.tsx | Client reason vs internal note split |
| 60 | decline | No bureau name/contact or next steps (s62) | FIXED | #152 | decline-view.test.ts | Bureau phone numbers need confirming (#152 note) |
| 61 | decline | Timeline order wrong | FIXED | #152 | lib/portal/application-view.test.ts |  |
| 62 | decline | Categories lack Fraud/Policy/Other | FIXED | #152 | decline-category.test.ts |  |
| 63 | OK | Affordability FAIL blocked at approval | OK | - | - | Positive observation |
| 64 | affordability | Own active loan in arrears not counted in NDI | FIXED | #138 | components/applications/wizard/own-lender-arrears.test.tsx; lib/affordability tests (IT per PR) | Warning shown on client and affordability steps; Browser 2026-10-19 (staging, main 03c1ba34): B3 Thabo Sithole (60 DPD) portal application: staff page shows "In arrears with us: 60 days, R 2,058.34", own loan R1,029.17 counted (existing debt R1,330 -> R2,359.17). Gap: portal qualify page excludes it (new row 111) |
| 65 | staff/app | NO BLOCKERS shown while not affordable | FIXED | #140 | lib/applications/rail-blockers.test.ts |  |
| 66 | demo | Simulated bureau identical for everyone | DATA | #149 | lib/integrations/experian-dry-run.test.ts | Score 600-700 per ID |
| 67 | payments | Notify-payment not in reconciliation queue | FIXED | #141 | lib/payments/payment-notifications.integration.test.ts; app/(dashboard)/payments/page.test.tsx | Role aligned to capture_payment in #150 |
| 68 | settlement/COB | COB R27,133.91 vs settlement R33,877.51 | FIXED | #146 | lib/loan/s125-settlement.test.ts | Hein signed off incl. COB changes. "Section 112" citation: no evidence legal checked it (note) |
| 69 | reminders | WhatsApp reminders "R 0.00"; threatening due-day copy | FIXED | #141 | lib/collections/reminders.test.ts; app/api/cron/payment-reminders/route.test.ts | Meta v3 template needs approval per lender (GATED, progress file); old Meta bodies unchanged |
| 70 | OK | Record Payment works; form keeps reference | FIXED | #141 | components/loans/PaymentForm.reset.test.tsx | Positive plus the form-reset defect fixed |
| 71 | collections/S129 | S129 cannot be issued: email not configured; reason hidden | FIXED | #147 (+#158) | section129-email.test.ts; section129/route.test.ts; Section129Button.test.tsx; lib/collections/section129-failures.test.ts | Simulated transport for demo slugs only |
| 72 | collections | Counts disagree across sidebar/page/dashboard | FIXED | #138 | lib/reports/book-arrears.integration.test.ts; app/(dashboard)/collections/page.test.tsx |  |
| 73 | collections | Three loan-ref formats; AF client shown "Personal" | FIXED | #152, #147 | lib/loan/loan-reference.test.ts; lib/collections/loan-kind.test.ts | New loans get one format; seed refs like LN-SEED-0001 remain (not changed) |
| 74 | collections | S129 confirmation tiny inline | FIXED | #147 | Section129Button.test.tsx |  |
| 75 | OK | Payment plan created (panel did not refresh) | FIXED | #147 | PaymentPlanButton.test.tsx | router.refresh added |
| 76 | AF/demo | Every AF record named TEST/Synthetic | DATA | #149 | prisma/seed-asset-finance.integration.test.ts "labels no asset-finance record … TEST or Synthetic" |  |
| 77 | AF | Contract type not shown; Instalment Sale label on finance lease | FIXED | #151 | app/(dashboard)/asset-finance/deals/deal-pages.test.tsx | E2 |
| 78 | AF/NCA | NCA-regulated deal APPROVED/BOOKED despite caption | FIXED | #151 | deal-pages.test.tsx; prisma/seed-asset-finance.integration.test.ts | E3: no gate hole; stale caption replaced |
| 79 | AF | Trustee bureau SKIPPED vs reason "checked" | FIXED | #151 | lib/asset-finance/deal-decision.test.ts (E6) |  |
| 80 | AF/SoD | Payout maker = checker | FIXED | #140 | lib/asset-finance/payout-booking.integration.test.ts |  |
| 81 | AF | Documents DRAFT-NOT FOR EXECUTION, placeholder clauses | GATED | - | - | Legal sign-off on AF clauses (Hein) |
| 82 | OK | Operating lease creation/PDF correct | OK | - | - | Positive observation |
| 83 | AF/op-lease view | Saved op-lease page shows loan schedule | FIXED | #151 | lib/asset-finance/lease-deal-page.integration.test.ts | E1; page == PDF figures; Browser 2026-10-19 (staging, main 03c1ba34): op lease AF-MNFLXDJS-M5BH: all 36 rentals + totals (R378,288.87 / R56,743.33 / R435,032.20) identical on page and PDF |
| 84 | AF | Lease pages say Borrower/Deposit/balloon; unit Hours; months 6036 | FIXED | #151 | deal-pages.test.tsx; DealCreateForm.test.tsx; asset-book-status.test.ts |  |
| 85 | AF | Product dropdown lists Micro/Personal | FIXED | #151 | lib/asset-finance/product-kind.integration.test.ts |  |
| 86 | AF | Unfinanced asset shows "On book" | FIXED | #151 | asset-book-status.test.ts |  |
| 87 | AF/risk | Director in default, no cross-reference | FIXED | #151 (+#156) | lib/asset-finance/deal-exceptions.integration.test.ts | Policy defaults (1.5x arrears-growth cap, no override post-approval) for Hein to confirm |
| 88 | AF/PDF | Lessor block placeholders; stale Prime 10.75% | DATA | #149, #151 | prisma/demo-lender.test.ts | PARTIAL: lessor = fictional demo identity. Prime 10.75% from 2025-01-01 still in prisma/seed/asset-finance-data.ts:23, #151 left it |
| 89 | OK | Full-maintenance lease preview correct | OK | - | - | Positive observation |
| 90 | AF/FML view | FML page shows loan schedule, omits maintenance | FIXED | #151 | lib/asset-finance/lease-deal-page.integration.test.ts | E1; Browser 2026-10-19 (staging, main 03c1ba34): FML AF-MNFLXCO4-KER0: all 36 rows (rental, maintenance, VAT) + totals (R412,916.16 / R172,758.12 / R87,851.12 / R673,525.40) identical |
| 91 | AF | Not tested: sole-prop refusal, payout/billing/termination | INFO | - | - | NOT TESTED list |
| 92 | insurance | BLOCKER Failed to render disclosure (Invalid storage path) | FIXED | #139 | app/api/insurance/policies/draft/route.test.ts "issues the disclosure for real-length ids…" |  |
| 93 | insurance | Commission = 20% of sum assured | FIXED | #139 | app/api/insurance/policies/route.test.ts; PolicyCreationWizard.test.tsx |  |
| 94 | insurance | Claim approved R1,000,010,000 on R10,000 claim | FIXED | #139 | app/api/insurance/claims/[id]/route.test.ts; approve-bound.integration.test.ts |  |
| 95 | insurance | TEST credit life product; real insurer prefill; New Claim link; search | FIXED | #139 | PolicyCreationWizard.test.tsx; NewClaimForm.test.tsx; lib/list-search.test.ts; prisma/seed-asset-finance.integration.test.ts |  |
| 96 | insurance/concept | Staff "Approve/Reject" insurer claims | FIXED | #139 | ClaimDecisionModal.test.tsx | "Record insurer decision" |
| 97 | OK | Complaint status update works (no Acknowledged option; 7d unacknowledged) | FIXED | #147 | complaints/[id]/route.test.ts; status-flow.test.ts | Acknowledge option added. Demo's 7-day-old complaint is seed data, not checked |
| 98 | RBAC | INSURANCE_OFFICER records payments, full nav | FIXED | #139, #145, #150 | app/api/loan-money-rbac.test.ts; proxy.loan-book-scope.test.ts; app/api/collections-scope-rbac.test.ts |  |
| 99 | RBAC/UX | LOAN_ADMIN /settings/users renders public site | FIXED | #139 | lib/__tests__/auth-guards.no-access.test.ts |  |
| 100 | public site | Top bar NCR placeholder NCRCP99999 | DATA | #149 | prisma/demo-lender.test.ts; Footer.demo.test.tsx | Real NCRCP needed before market. Hein 2026-10-19: Fair Score is a demo, placeholder accepted |
| 101 | portal/apply | Micro card "up to R7,700" vs R2,000 max; silent refusal | FIXED | #141 (+#152) | lib/__tests__/qualify.test.ts; PortalApplyProductClient.amount.test.tsx; layout.test.tsx | Reset of checkboxes: #152 |
| 102 | portal/apply | Declined 1h ago yet "You qualify" BEST MATCH | FIXED | #141 | PortalApplyClient.test.tsx; apply/page.test.tsx | 30-day window (default, Hein to confirm) |
| 103 | OK | Micro R2,000/30d submitted | OK | - | - | Positive observation |
| 104 | portal/PO funding | No PO data asked; consumer purposes | FIXED | #141 (+#150) | Step2LoanParams.po.test.tsx; app/api/portal/applications/route.test.ts; RUN_PO_FUNDING_IT |  |
| 105 | public site | No AI chat; placeholder FSP, co. reg, phone, email | GATED | #149 | prisma/demo-lender.test.ts | Placeholders fixed as demo data; chat needs LLM key (workstream H) - no PR |
| 106 | public site | Complaints copy points to Tribunal first | FIXED | #147 | complaints-route-copy.test.ts | Hein signed off; af/zu/xh still old route (progress file) |
| 107 | NCR return | Book/PAR differ across screens; no arrears history | FIXED | #138, #153 | lib/reports/book-arrears.integration.test.ts; lib/reports/arrears-snapshot.integration.test.ts | History starts at first nightly run, not backfilled |
| 108 | bank recon | Statement import ABSA CSV only | GATED | #147 | - | FNB/SB/Nedbank/Capitec CSV samples needed |
| 109 | demo data | Data left by audit | INFO | - | - | Pre-audit dump in backups/ |
| 110 | NOT TESTED | Untested areas list | INFO | - | - |  |
| 111 | portal/apply | Qualify page ignores the client's own loans with the lender: 60-DPD borrower shown existing debt R1,330 (not R2,359.17) and "qualifies up to R100,000" | FIXED | #194 | app/(portal)/portal/apply/page.test.tsx, [product]/page.test.tsx; local browser 2026-10-19 (existing debt R2,359.17 + overdue notice) | Staff assessment is correct (row 64); misleading pre-qualification only. MEDIUM |
| 112 | AF | Supplier-evidence links on an individual lessee's deal go to /api/asset-finance/entities/null/documents/... (404) | FIXED | #196 | lib/asset-finance/deal-evidence-url.test.ts; local browser 2026-10-19 (5 links 200 + DocumentAccessLog) | LOW-MEDIUM: evidence files unreachable from the deal page |
| 113 | AF/credit memo | Booked FML deal lists its own booked loan as an existing exposure ("has loan LN-MNFLXD6L-HDVD with this lender: Defaulted, 79 days") | FIXED | #196 | lib/asset-finance/deal-exceptions.test.ts + .integration.test.ts; local browser 2026-10-19 | LOW: memo exceptions computed live, include the deal's own loan |
| 114 | collections | Payment plan 3 x R686.11 = R2,058.33 vs arrears R2,058.34 (last instalment not adjusted) | FIXED | #197 | lib/collections/payment-plan.test.ts; payment-plan/route.test.ts; local browser 2026-10-19 (2 x R686.11 + final R686.12) | LOW: 1 cent left in arrears |
| 115 | collections | Stage hint says "Use the S.129 Notice action above" while the button says unavailable (<90 DPD) | FIXED | #197 | CollectionsStagePanel.test.tsx; section129-hint.test.ts; local browser 2026-10-19 | LOW copy |
| 116 | insurance | Catalogue card shows R118/mo; the rate table gives R171 for the client (wizard now offers "Use R171.00") | FIXED | #162, #203 | lib/insurance/headline-premium.test.ts; PolicyCreationWizard.test.tsx; local browser 2026-10-19 (From R 62.00 main member, cover R 10,000; prefill matches) | Card shows the cheapest sellable main-member quote via rateLife + canSellProduct gate; otherwise Price on quote |
| 117 | i18n | Mixed currency formats on one screen: "R 20 000,00" (catalogue/summary) vs "R 34.20" / "R 20,000.00" | FIXED | #195 | InsuranceDashboardClient, QuickQuoteResults, Step3Confirm tests; local browser 2026-10-19 (pre-fix-round screenshots) | LOW |
| 118 | portal i18n | Afrikaans portal shows English strings: "CURRENT ACCOUNT AMOUNT" panel, signing/OTP copy, apply declarations, "Personal Loan" | FIXED | #198 | portal-signing/locale tests (SigningOtpStep, PortalAgreementClient, mandate, deal signer); local browser 2026-10-19 | UI labels translated; consent, agreement, mandate, collections and signing-instruction text stay English by rule (lib/i18n/.claude.md). Catalogue hash changed: demo needs re-seed/re-bake for af/zu/xh review records |
| 119 | staff/404 | Staff 404 page offers "Apply online" / "Check if I qualify" (public-site links) | FIXED | #199 | app/not-found.test.tsx; local browser 2026-10-19 (staff vs public host) | LOW |
| 120 | portal/sign | Clicking "I Accept and Sign Digitally" with declarations unticked does nothing visible | FIXED | #199 | PortalAgreementClient.test.tsx; local browser 2026-10-19 (alert lists unticked, focus first) | LOW: no message on what is missing |
| 121 | collections/S129 | Section 129 notice prints arrears R669.00 but outstanding balance / "total outstanding obligation" R500.00 (principal only) | FIXED | #191 | Simulated S129 PDF LN-MQKMIRLR-TIKK, 19 Oct | HIGH: NCA notice numbers; fix needs Hein sign-off |
