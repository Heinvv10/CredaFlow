ye? # Functional and configuration coverage

Revision `5cb9279bc17d3c306e49c06c75b27660894eba73`, synthetic local audit on 17 October 2026. Read this with [REPORT.md](REPORT.md). “Inspected” means the page and its rendered controls/data were reviewed; it does **not** mean every control was submitted. “Exercised” identifies an actual browser journey. “Blocked/unverified” preserves the boundary where provider/configuration/legal prerequisites were absent.

## Functional areas

| Area / paths | Evidence level | Outcome and limits |
|---|---|---|
| Staff login / TOTP | Exercised | Admin TOTP enrollment and subsequent code-based sign-in passed; no complete lockout/recovery matrix |
| Staff dashboard `/dashboard` | Inspected, desktop/mobile | Loaded; sample mobile layout fitted 390px; synthetic delinquency-heavy data needs presentation context |
| Applications list/new/detail | All 56 starting details inspected; selected mutations exercised | Review/signing/disbursement/PO flows in main report; F01/F04/F08; fresh micro/personal approvals not fully repeated |
| Clients list/new/detail/edit | Inspected; READONLY boundary exercised | Editable form exposed to READONLY, actual PATCH refused 403; client identity/death/blacklist/consent mutations not comprehensively exercised |
| Loan accounts `/loans/[id]` | All 35 starting loans inspected; new loan and receipt mutation exercised | Schedules/statuses/receipts displayed; total-paid reconciliation passed for all 36 final loans |
| Payments and notifications | Exercised receipt allocation and reversal | R100 notification and proof, allocation, portal balance change, reversal and restored balance passed |
| Bank reconciliation `/payments/bank-reconciliation` | Inspected | Import/review controls visible; a fresh end-to-end statement CSV import was not performed in browser |
| Disbursements/payout list | Inspected; one simulated payout exercised | Real transfer/return, voucher and PayShap acceptance absent; F01 |
| Collections list/detail/batches | Inspected; non-NCA notice refusal exercised | Backend statutory-regime refusal held; F05; no new actual debit batch, attorney referral, arrangement, write-off or recovered-money journey |
| Arrears/default-charge reports | Inspected; real DB suites executed | Reports loaded; no full dated browser accrual lifecycle or independent legal interpretation of all charges |
| Asset entities/new/edit/people | Both existing entities plus create/edit/person forms inspected | Trust/company and representative/surety surfaces present; fresh registrations/signatory changes not submitted |
| Financed assets/new | All six asset details and creation form inspected | Existing identifiers/details visible; new asset/VIN duplicate workflow not manually executed |
| Suppliers/new | Both supplier details and creation form inspected | Bank/check evidence surfaces reviewed; fresh dual-authorized supplier-bank changes not exercised |
| Asset deals/new | All six booked deals and new-deal form inspected | Four contract types present; fresh legal approval/signing/payout lifecycle not performed; F04 |
| Asset reference rates | Inspected | Existing rate-management interface rendered; no live rate-feed acceptance |
| Asset maintenance/recovery/end term | Existing deal/loan records and available controls inspected | April accounting included seeded maintenance/recovery events; no new browser mutation for each branch |
| Customer portal overview | Exercised authenticated access | Individual borrowers and business representative had separate sessions |
| Portal applications | Inspected and PO submission exercised | Application statuses/timeline rendered; freshly submitted PO reached staff review |
| Portal apply: micro, personal, PO | All three forms inspected; PO submitted | Loan eligibility and document requirements visible; no fresh completion for every product |
| Portal agreement | Exercised | PASQ/packet, five declarations, demo code, customer signature, completed-state revisit; F15 |
| Portal debit mandate | Exercised | Three consents, demo code, signature/download; actual bank mandate registration unverified |
| Portal loans/statement/payment | Exercised | Own PDF statement 200, other borrower statement 403; receipt/reversal reflected in balance; F07/F12 |
| Portal documents | Inspected and proof upload used | Rendered document access; all active artifact paths/hash availability checked; biometric/selfie flow unverified |
| Portal profile/notifications | Inspected | Loaded; full profile-edit/opt-out/change-password recovery matrix not exercised |
| Portal insurance/detail | Inspected own credit-life policy | Missing online disclosures clearly stated; beneficiary changes not offered in that view; new policy issue not exercised |
| Portal business/entity/contracts | Inspected with authorized business representative | Business and contract surfaces rendered; fresh multi-signatory token acceptance unverified |
| Mobile portal navigation | Inspected visible DOM and screenshot | F06; no complete global mobile menu/sign-out |
| Insurance staff list/new | Inspected | Five starting policies; fresh policy sales journey not completed |
| Insurance claims/new | Existing claim approval/payment exercised | Over-approval refused; valid approval/payment record passed; rejection/new claim/docs/insurer delivery not all exercised |
| Insurance product/rate/eligibility | Both products inspected, including rate/eligibility subpages | Family funeral active table and terms present; TEST credit-life quote configuration missing |
| CRM dashboard/leads/new/queue/opportunities | Inspected | Pipeline and forms loaded; 23 starting leads; no full create→convert→issue loan journey |
| Lead convert/duplicates | Representative forms inspected | Convert identity wizard present; duplicate screen correctly reported no matches for tested lead; merge not available |
| Agent hub/re-engagement | Inspected | Workflow surfaces present; no actual outbound campaign or customer send |
| Contacts/detail | Inspected | Linked borrower and identities rendered; 58 starting contacts; no full deduplication/inbound-channel matching acceptance |
| Inbox/reconciliation | Inspected | Pages loaded; real IMAP/WhatsApp inbound and routing not exercised |
| Compliance dashboard | Inspected | F11: headline scope needs clearer labeling |
| NCR return / FSCA return | Inspected | No actual regulator submission or accepted regulator output established |
| COI / TCF | Inspected | Registers rendered; new staff attestation/approval cycle not completed |
| Complaints / DSAR / breach log | Inspected | Register/form surfaces rendered; fresh full complaint/DSAR export/redaction/resolution lifecycle not completed |
| Bureau overrides / submissions | Inspected, DB suites executed | No real bureau enquiry/submission sent; no live manual override accepted |
| FIC / screening | Inspected | Prerequisites incomplete/off; no real screening, case review or FIC submission |
| Reports index/advisor/board pack | Inspected | Report surfaces loaded; F03 materially incomplete composition; no completeness proof for every export |
| Accounting preview/settings/close/history/CSV | Exercised | Mapping confirmation, go-live, April close, authenticated CSV, totals/tie-out passed; F10 stale preview |
| Academy `/learn` / sample lesson | Inspected | Written lesson steps visible; sample media 404, F14; not all lesson media opened |
| Public `/site` / apply / qualify | Inspected unauthenticated | Pages/forms rendered; no unauthenticated submission + OTP complete journey |
| Public calculators/contact/legal/regulatory | Inspected, selected mobile | Pages rendered; calculator boundary correctness/contact delivery/legal approval not certified |
| Public insurance / quote hosts | Inspected, gated | Quote pages unavailable/404 when the FSP widget is unconfigured; not classified as a broken advertised link without a configured public CTA |
| Operator control plane | Unverified | Operator-specific session, lender creation/support grants/users/usage/security not fully exercised |
| Password/reset/token signing/selfie routes | Partial / unverified | Ordinary logins and signing tested; full recovery, token expiry/replay and selfie-browser acceptance not established |
| Payment success/failure return pages | Unverified | No real online-provider payment to generate and verify these returns |

## Settings inventory

All settings below were opened in the browser. The listed mutation scope is the limit of manual acceptance; automated database tests provide additional evidence but do not turn every settings page into a browser pass.

| Settings route | Reviewed content / controls | Browser save/mutation scope and outcome |
|---|---|---|
| `/settings` | Settings navigation and access | Inspected |
| `/settings/identity` | Lender identity, regulatory/contact/branding fields | Inspected; no legal identity changed |
| `/settings/security-policy` | TOTP, separation of duties, KYC policy | Inspected desktop/mobile; Admin-only view respected SUPER_ADMIN change restriction; tenant policy not activated for a real lender |
| `/settings/security` | Current-user TOTP/security | Admin enrolled and completed fresh TOTP login |
| `/settings/users` | Staff roles/accounts/status | Created synthetic READONLY user and confirmed its session/403 write boundary |
| `/settings/branches` | Branch records / management | Inspected; no branch reassignment or cross-branch matrix |
| `/settings/credit-policy` | Credit decision thresholds/settings | Admin inspection; loan-admin page and API access refused |
| `/settings/products` | Product landing | Redirect to loan-product list verified |
| `/settings/products/loan` | All five configured products | List and each editor inspected; F02 |
| `/settings/products/loan/new` | New-product form | Inspected; did not create or reprice products |
| `/settings/products/insurance` | Both configured products | Inspected |
| Insurance product editor | Underwriter, cover/premium/commission | Inspected; did not alter approved pricing |
| Insurance product `rates` | Versioned rate bands and activation state | Both products inspected; active funeral card immutable; TEST credit life has no table |
| Insurance product `eligibility` | Age/cover/waiting-period rules | Both inspected; TEST credit-life mandatory rules absent |
| `/settings/products/insurance/new` | Product creation | Inspected, no product created |
| `/settings/asset-finance` | Asset legal/operational configuration | Inspected; legal approval deliberately not enabled |
| `/settings/repo-rate` | Repo record and approval basis | Inspected; restored approved rate used by actual cap helper; no live-rate fetch/approval |
| `/settings/integrations` | Providers, simulation/environment flags | Enabled collections in synthetic tenant only to establish F01 cause and continue simulated AVS/payout; live credentials not supplied |
| `/settings/bank-sync` | Bank import setup | Inspected; no bank connector activated |
| `/settings/email` | Sender/mailbox/transport configuration | Inspected; outbound email deliberately disabled/incomplete; no external delivery proved |
| `/settings/email/logs` | Delivery/processing logs | Inspected; logs do not establish real delivery |
| `/settings/comms` | Communication defaults/templates | Inspected; no external messages sent |
| `/settings/notifications` | Notification templates/configuration | Inspected; F13 implementation copy |
| `/settings/whatsapp` | WhatsApp configuration/templates | Inspected; no registration, template approval or message delivery |
| `/settings/automation` | Rules/scheduled behavior | Inspected; actual scheduler disabled in private environment |
| `/settings/documents` | Template list/version controls | Inspected |
| Document template editor | HTML/tokens/preview/draft/version UI | Representative template opened; no legal wording edited/published |
| `/settings/insurance` | Insurance feature configuration | Inspected; no new policy feature activation |
| `/settings/insurers` | Underwriter details/commission | Inspected; no real insurer data modified |
| `/settings/attorneys` | Attorney settings | Inspected; no actual referral sent |
| `/settings/languages` | Enabled languages/configuration | Inspected; translations not exhaustively accepted |
| `/settings/api` | API settings | Inspected; no new external credentials distributed |
| `/settings/support-access` | Operator support-access surface | Inspected; no support grant opened/exercised against another lender |
| `/settings/audit-log` | Search/filter/event presentation | Inspected; final DB event extract confirms selected state changes |
| `/settings/login-log` | Authentication log presentation | Inspected; logins/refusals separately exercised |
| Accounting settings on `/reports/accounting` | Mapping, VAT, go-live and confirmation | Confirmed all 16 mapping roles and set synthetic April go-live; closed month; F10 |
| Asset reference rates on `/asset-finance/reference-rates` | Prime/reference-rate management | Inspected; no rate changed or live feed approved |

## Untested combinations and functional branches

The inventory explicitly leaves these open: every role × branch × tenant × action combination; all 161 route patterns; every setting save/rollback; all token expiry/replay cases; new asset-deal origination/signatures/payout per contract/borrower shape; borrower registration/reset; legal notice issuance and service proof; real document OCR/selfie verification; complete complaint/DSAR/insurance sales lifecycles; actual bank/provider settlement and accounting destination acceptance; scheduler and deployment operations; concurrency/load/soak testing; all browsers/devices/languages/accessibility modes.

Do not advertise these as accepted because adjacent pages rendered or mocked tests passed. The remaining acceptance scope should be reduced only by an explicit launch feature decision or new evidence.
