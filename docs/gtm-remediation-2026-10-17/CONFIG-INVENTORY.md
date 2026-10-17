# Synthetic candidate configuration inventory

Measured against MQ's owned restored Tsela database on 17 October 2026, current application base `3a0a17e38b393d0c0707ed24e615be2b016f604e`. This is synthetic configuration presence/status, not real lender approval or provider acceptance. Private machine-readable evidence: `/tmp/cf-gtm-rc-20261017-mq-hMJamG/evidence/config-inventory.json`; trigger/CHECK catalogs retained beside it.

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
| G14 OCR/AI | Runtime allow-list has no VLM endpoint/key. Prior statement-analysis accuracy/semantics gates remain failed/stopped per LATEST; passing unit/face-model checks cannot upgrade statement-AI accuracy. |
| G15 accounting destination | External Xero/IsaFlow credentials stripped. Local preview/close/export acceptance pending F10; destination writes require target authority. |
| G16 scheduler | No CRON_SECRET or scheduler configured for candidate. Three restored heartbeat rows are historical fixtures, not evidence of a running scheduler. |
| G17 operator | No operator-browser acceptance yet. Requires isolated real session and fresh eligible support/recovery fixtures. |
| G18 deployment | Owned DB/uploads backup restore passed: 35 loans/56 applications/60 payments, allocation invariant both DBs, all 443 files byte-identical. Fresh image/provenance/browser/full gates pending. No public target authorized. |
| G19 additional journeys | Original snapshot is a baseline fixture; fresh lifecycle/provider/token journeys must each receive separate evidence. Existing signed/booked rows are not fresh execution. |
| G20 accessibility/packaging | Installed Chrome/PDF tools available; browser keyboard/mobile/theme/media checks pending candidate. No WCAG or cross-browser certification claimed. |

Safety: candidate app will run on its own internal Docker network with explicit synthetic environment allow-list. No external provider secrets or scheduler secret are copied. Database credential columns were cleared only in this owned disposable copy. All original demos, audit runtime and snapshot files remain untouched.
