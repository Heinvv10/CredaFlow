# Synthetic candidate configuration inventory

## Final accepted core scope

Core source `63a96479d290b215049b3a3e46977dc09305c21f` merged as `9dfb76b90fa5b8b5a87fb1430d1af3ffedca5f4a`. [ACCEPTANCE.md](ACCEPTANCE.md) records the authoritative final G01–G20 outcomes; [FINAL-RELEASE.md](FINAL-RELEASE.md) records exact gates, browser scope, immutable image and four final restore drills. The table below preserves the initial measurement and its then-pending work, not current acceptance status.

The final private core environment keeps provider credentials/scheduler/VLM unset, advisory Statement AI disabled, and original payout/collections flags restored after explicitly simulated AVS checks. Actual local SMTP delivery and supported synthetic Turnstile tests were exercised; no external customer messages or real provider transactions occurred. OCR/statement-reader corpus accuracy checks were explicitly skipped and remain unmeasured. The separate private F15 legal proposal environment is not included in this accepted core configuration.

## Historical preparation measurement

Historical preparation snapshot measured against MQ's owned restored Tsela database on 17 October 2026, application base `3a0a17e38b393d0c0707ed24e615be2b016f604e`. This is synthetic configuration presence/status, not real lender approval or provider acceptance. Private machine-readable evidence: `/tmp/cf-gtm-rc-20261017-mq-hMJamG/evidence/config-inventory.json`; trigger/CHECK catalogs retained beside it.

The restored fixture contains 16 active, 10 defaulted, 2 written-off and 7 completed loans. These are deliberately synthetic stress scenarios from the 16 October bake; they must not be presented as a healthy real lender book. No provider or legal setting was activated to improve this inventory.

| Gate | Measured preparation / explicit boundary |
| --- | --- |
| G01 identity/legal | Synthetic legal name/NCR/FSP fields present. `assetFinanceLegalWordingApproved=false`; real lender identity and all applicable rendered contract approvals remain external. |
| G02 launch pricing | Existing product settings preserved; launch boundary/rate consistency acceptance depends on F02. No products repriced or historical contracts altered. |
| G03 rates/eligibility | Active `TEST-AF-CREDIT-LIFE` has zero active rate tables and zero active eligibility rule types, including all four mandatory types. Family Funeral has one active table and MIN_ENTRY_AGE/MAX_ENTRY_AGE/MAX_COVER/MAX_TOTAL_COVER/WAITING_PERIOD_DAYS rows. Presence does not certify insurer-approved suitability. |
| G04 disclosures/beneficiaries | Five policies; one lacks FAIS PDF, all five lack recorded PPR issue and acknowledgement, all five have zero beneficiaries. Product applicability and insurer-approved disclosures/beneficiary requirements need explicit review; no fabricated historical acknowledgements. |
| G05 FIC/screening | Screening provider unset; zero RMCP documents. No real screening or FIC submission acceptance. |
| G06 staff security | `requireStaffTotp=true`; all nine seeded staff have TOTP enabled, including one SUPER_ADMIN. No demo TOTP waiver applied. Real-browser TOTP, recovery/operator/audience isolation still pending. |
| G07 bureau/KYC | Bureau order is Experian; all copied provider credentials stripped. Real bureau/biometric results unverified; synthetic acceptance must identify simulation explicitly. |
| G08 OTP/delivery | Signing OTP required. EmailConfig active count zero after safety stripping; no external delivery claimed. Local demo reveal is distinct from real email delivery. |
| G09 mandate | Original synthetic snapshot preserved; fresh fail-closed and signing scenarios pending. Actual approved creditor/bank/provider acceptance external. |
| G10 AVS/payout | Payout engine off, collections off, payout/AVS providers unset. F01 acceptance will use isolated simulated configurations and restore them; no bank transfer authorized. |
| G11 collections | Engine off. Real mandate submission/collection settlement/returns remain external. DB invariants pending integrated gate. |
| G12 online payment | Stitch credentials stripped and absent from runtime allow-list. Signed synthetic callback/return fixtures pending; no real settlement claimed. |
| G13 messaging | Zero active email configs; zero WhatsApp-enabled configurations. BulkSMS/Netcash/TransUnion/Smile dispatch disabled. SMS remains off by policy; all real messages forbidden. |
| G14 OCR/AI | Runtime allow-list has no VLM endpoint/key. Prior statement-analysis accuracy/semantics gates remain failed/stopped per LATEST; passing unit/face-model checks cannot establish OCR/statement-reader accuracy; this is distinct from the newer disabled advisory Statement AI feature. |
| G15 accounting destination | External Xero/IsaFlow credentials stripped. Local preview/close/export acceptance pending F10; destination writes require target authority. |
| G16 scheduler | No CRON_SECRET or scheduler configured for candidate. Three restored heartbeat rows are historical fixtures, not evidence of a running scheduler. |
| G17 operator | No operator-browser acceptance yet. Requires isolated real session and fresh eligible support/recovery fixtures. |
| G18 deployment | Owned DB/uploads backup restore passed: 35 loans/56 applications/60 payments, allocation invariant both DBs, all 443 files byte-identical. Fresh image/provenance/browser/full gates pending. No public target authorized. |
| G19 additional journeys | Original snapshot is a baseline fixture; fresh lifecycle/provider/token journeys must each receive separate evidence. Existing signed/booked rows are not fresh execution. |
| G20 accessibility/packaging | Installed Chrome/PDF tools available; browser keyboard/mobile/theme/media checks pending candidate. No WCAG or cross-browser certification claimed. |

Safety: candidate app will run on its own internal Docker network with explicit synthetic environment allow-list. No external provider secrets or scheduler secret are copied. Database credential columns were cleared only in this owned disposable copy. All original demos, audit runtime and snapshot files remain untouched.

Current demo completion: PR171 merged the approved synthetic declaration candidate as0acd1bdf, with frozen source70ab and private image02b900ad. The historical table above is not a current acceptance checklist. See ACCEPTANCE.md and FINAL-RELEASE.md for the final browser, local/hosted gate and paired restore evidence. Only the separate owned declaration/demo fork enabled the existing Experian UAT policy for already-recorded synthetic bureau evidence and configured a non-relaying local SMTP sink through the audited staff API; no real provider was activated. Final collections and payout engine flags were restored off, VLM and scheduler secrets remain absent, and the baked tenant/Turnstile test inputs are not production promotion inputs. Explicit demo approval does not replace future named-lender legal review or target-specific provider, credit-life, OCR accuracy and deployment acceptance.
