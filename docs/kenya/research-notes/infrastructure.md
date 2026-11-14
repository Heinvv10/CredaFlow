# Kenya integration infrastructure for a loan management system (CredaFlow), as of Nov 2026

Scope: what each CredaFlow South African integration maps to in Kenya. Research date 2026-11-06.
Source quality warning: Safaricom, the CRBs, Smile ID and Africa's Talking publish little official pricing. Many
2026 figures below come from third-party developer blogs (paybillke.com, kenzobe.com, mctaba.com, helloduty.com) and
are marked unverified where that is the case. africastalking.com/pricing and techcabal.com returned HTTP 403 to fetch;
their content below comes from search snippets only.

Rough SA → Kenya mapping (inference, detailed and sourced below):

| SA integration | Kenya equivalent |
|---|---|
| Stitch payouts | M-Pesa B2C (Daraja), Airtel Money disbursement, PesaLink/EFT for bank accounts |
| Debit orders / DebiCheck | M-Pesa Ratiba standing orders (API), STK Push per instalment, payroll check-off; bank direct debit thin |
| Payment reconciliation (EFT in) | M-Pesa C2B paybill/till confirmation callbacks (account number = loan ref) |
| TransUnion / Experian | TransUnion Kenya, Metropol, Creditinfo Kenya (only 3 CBK-licensed CRBs) |
| SmileIdentity KYC | Smile ID Kenya (IPRS, eCitizen, BRS), Youverify, deepidv, Didit, Prembly; KRA PIN check |
| Bank statement upload + AI | M-Pesa PDF statement upload + parse (the de facto affordability input), plus bank statements |
| BulkSMS | Africa's Talking (SMS + USSD), sender ID registration per network |
| WhatsApp Cloud API | Same Meta API, unchanged (not researched further) |
| Resend email | Unchanged |
| pdf-lib e-signed agreements | E-signature valid under KICA; "advanced" signatures need a CA-licensed certification provider |

## 1. Mobile money: M-Pesa Daraja, Ratiba, Airtel Money, aggregators

### Takeaway
M-Pesa Daraja is the core rail: B2C for disbursement, C2B paybill/STK Push for repayment, Transaction Status and Reversal
for ops. Go-live needs a registered Kenyan entity, KRA PIN, a live paybill/till, and a separate B2C approval with a
pre-funded float. M-Pesa Ratiba is the closest thing to a DebiCheck-style recurring pull (customer approves once, Safaricom
debits on schedule into your paybill), but it is enabled per shortcode on request and its API docs/pricing are not
confirmed from Safaricom itself.

### Cited Findings
**Daraja products and mechanics**
- Daraja endpoints: OAuth, STK Push (`/mpesa/stkpush/v1/processrequest`) + STK Query, C2B Register URL (+ Simulate in sandbox only), B2C (`/mpesa/b2c/v1/paymentrequest`), Account Balance, Transaction Status, Reversal (completed C2B or B2C), Tax Remittance (`/mpesa/b2b/v1/remittax`), B2B. Prod base `api.safaricom.co.ke`, sandbox `sandbox.safaricom.co.ke` — [paybillke.com Daraja guide 2026](https://paybillke.com/guides/mpesa-daraja-api-complete-guide-2026) (third party)
- Access tokens last 3599 s; cache and refresh early. Approximate (not Safaricom-published) rate limits: OAuth ~300/min per consumer key, STK Push ~100/min per shortcode; B2C throttled by daily payout limit — [paybillke.com](https://paybillke.com/guides/mpesa-daraja-api-complete-guide-2026) (unverified)
- Callbacks: production requires HTTPS with a valid (not self-signed) cert, publicly reachable; return 200 fast (<5 s recommended); Safaricom may replay callbacks, so handlers must be idempotent. Conflicting guidance on IP allowlisting (recommended to restrict to Safaricom AS37061; FAQ says not required) — [paybillke.com](https://paybillke.com/guides/mpesa-daraja-api-complete-guide-2026)
- Safaricom does not sign callbacks; integrators guard with a shared secret in the URL or IP allowlist — [moffhub/billing package notes](https://packagist.org/packages/moffhub/billing) via search snippet
- Common error codes: 500.001.1001 (subscriber locked by an open STK prompt, retry after ~30 s), 500.001.1032 (customer cancelled STK), 400.002.02 (invalid MSISDN; use 2547XXXXXXXX/2541XXXXXXXX), 404.001.03 (sandbox/prod credential mismatch), 2001 (invalid B2C initiator/security credential) — [paybillke.com](https://paybillke.com/guides/mpesa-daraja-api-complete-guide-2026)
- C2B callbacks carry the payer's first name as registered on M-Pesa (a payment field, not a verification service) — [Mpesa-C2B-Daraja tutorial](https://github.com/TheODDYSEY/Mpesa-C2B-Daraja/blob/main/TUTORIAL.md)

**Onboarding / Go-Live**
- Production needs a registered Kenyan business and KRA PIN plus a live paybill or till — [mctaba Daraja production checklist](https://www.mctaba.com/learn/mpesa/daraja-production-checklist); [Safaricom Lipa na M-Pesa requirements PDF (2023)](https://www.safaricom.co.ke/images/Downloads/Lipa-na-mpesarequirements.pdf) (includes an AML/KYC questionnaire)
- B2C needs its own "Go Live for B2C" approval with a documented use case reviewed by Safaricom; B2C payouts draw on pre-funded float in the shortcode; one source says a C2B shortcode cannot use B2C and vice versa (separate apps/credentials); B2C needs an initiator name + security credential encrypted with Safaricom's cert, and sandbox vs production certs differ (common post-go-live failure) — [kenzobe B2C vs C2B](https://www.kenzobe.com/blog/mpesa-b2c-vs-c2b); [mctaba checklist](https://www.mctaba.com/learn/mpesa/daraja-production-checklist)
- Go-live form needs the M-Pesa Org Portal username of a Business Administrator/Manager (case-sensitive) — [dev.to go-live guide](https://dev.to/msnmongare/how-to-go-live-with-m-pesa-daraja-api-production-environment-4h96)
- Approval time: 1–3 business days per one guide; "within 24 working hours" per another citing the Daraja FAQ — [paybillke.com](https://paybillke.com/guides/mpesa-daraja-api-complete-guide-2026); [kenzobe API keys guide](https://www.kenzobe.com/blog/mpesa-daraja-api-keys) (conflicting, both third party)
- Aggregators (e.g. Pay Hero) market "minutes instead of hours" go-live as a wrapper over Daraja — [Pay Hero, Oct 2026](https://payherokenya.com/2026/10/12/from-hours-of-setup-to-minutes-how-to-go-live-with-m-pesa-daraja-vs-the-pay-hero-way/)

**Limits and tariffs**
- Per-transaction cap raised to KES 250,000 (from KES 150,000), covering Send Money, Buy Goods, PayBill, on 21 Sep 2023 — [Safaricom press release](https://safaricom.co.ke/media-center-landing/press-releases/safaricom-gets-approval-to-increase-m-pesa-transaction-limits-to-ksh-250-000); [Business Daily](https://www.businessdailyafrica.com/bd/corporate/companies/safaricom-raises-m-pesa-transaction-limit-to-sh250-000--4376768)
- Daily limit KES 500,000, CBK-approved 14 Aug 2023 — [Nairobi News](https://nairobinews.nation.africa/safaricom-raises-m-pesa-transaction-limit-to-sh250000/); [People Daily](https://peopledaily.digital/business/m-pesa-airtel-money-daily-transaction-limits-increased-to-sh500000)
- Conflict: some 2026 dev blogs still cite a KES 150,000 B2C per-transaction ceiling — [kenzobe](https://www.kenzobe.com/blog/mpesa-b2c-vs-c2b); likely stale vs the 2023 Safaricom release; B2C-specific cap unconfirmed
- B2C tariff: no official 2026 rate card found. Third-party figures conflict: KES 29 per recipient ([paybillke bulk calculator](https://paybillke.com/calculators/mpesa-bulk-payments-calculator)) vs "banded, up to approx KES 108, discounted for enterprise" ([paybillke pricing summary](https://paybillke.com/guides/mpesa-business-pricing-summary-2026)); enterprise B2C rates negotiated via a Safaricom Business Account Manager. Official older bands: [Safaricom B2C bulk PDF](https://www.safaricom.co.ke/images/Downloads/M-PESA-bulk-payment-b2c.pdf) (undated)
- Safaricom cut till-to-wallet/paybill fees effective 7 Aug 2026 in a CBK-led move (may not be the B2C product) — [The Standard, Aug 2026](https://www.standardmedia.co.ke/business/article/2001554316/safaricom-halves-m-pesa-merchant-fees-in-cbk-led-move)

**M-Pesa Ratiba (standing orders)**
- Launched Oct 2024 as a standing-order feature for recurring payments to other users or Lipa na M-Pesa shortcodes — [TechAfrica News, Oct 2024](https://techafricanews.com/2024/10/04/safaricom-introduces-m-pesa-ratiba-enabling-automatic-standing-orders-for-recurring-payments/); [Glenbrook](https://glenbrook.com/payments_news/safaricom-introduces-m-pesa-ratiba-a-standing-order-feature/)
- Business API flow: your system asks Safaricom to create a standing order on the customer's M-Pesa profile; the customer approves once on phone; Safaricom debits on schedule into your paybill/till. Enabled per shortcode after a go-live request to apisupport@safaricom.co.ke — [Lumiere Labs Daraja SDK docs](https://daraja.lumierelabs.xyz/docs/daraja/telco-services/mpesa-ratiba) (third party)
- Request fields: unique order name per customer, start/end date (yyyymmdd), transaction type (paybill/buy goods), amount, payer MSISDN, frequency; listed use cases include loan repayments and hire-purchase instalments — [Lumiere Labs](https://daraja.lumierelabs.xyz/docs/daraja/telco-services/mpesa-ratiba)
- Pricing reported as 5% of transaction value capped at KES 5 per executed order, excl. VAT, charged to the business — [Lumiere Labs](https://daraja.lumierelabs.xyz/docs/daraja/telco-services/mpesa-ratiba) (UNVERIFIED against Safaricom)
- Sandbox returned HTTP 404 empty body for an app without the product enabled — [newtonmunene99/mpesa-api PR #66](https://github.com/newtonmunene99/mpesa-api/pull/66) (described as "Daraja 3.0 recurring billing: Ratiba, Lipa na Bonga, Bill Manager")

**Airtel Money**
- Official route is developers.airtel.africa; sandbox needs only a developer account; collections push a USSD prompt to the customer — [mctaba Airtel guide](https://mctaba.com/learn/mpesa/airtel-money-integration-kenya); [Salami SDK docs](https://salami.co.ke/docs/api/sdk-airtel)
- Kenya base URLs reported as `openapiuat.airtelkenya.com` / `openapi.airtelkenya.com`; disbursement `POST /standard/v2/disbursements/` requiring PIN encryption; other sources cite v1 paths — conflicting, verify on portal — [osenco/airtel SDK](https://github.com/osenco/airtel); [paykit-go issue #23](https://github.com/Flying-Tea-Squad/paykit-go/issues/23)
- Paystack supports Airtel Money in Kenya via Charge API (provider code "atl") — [boldrails](https://boldrails.com/payments/airtel-money-api) (third party)

**Aggregators**
- Paystack Kenya added "Pay with Pesalink" bank transfers at checkout/API — [Paystack blog](https://paystack.com/blog/product/pay-with-pesalink-is-now-live-in-kenya)
- Africa's Talking, Cellulant/Tingg, Pesapal, Flutterwave, Kopo Kopo: no 2026 lending-specific data found in this pass.

### Inferences
- Disbursement = B2C; repayment = C2B paybill with the loan account number as `BillRefNumber`, plus STK Push for "pay now" nudges; Ratiba for scheduled collection. Without Ratiba, M-Pesa has no lender-initiated pull: every STK Push needs the borrower to enter a PIN, so it is a prompt, not a debit order.
- One lender = at least two shortcodes (C2B paybill, B2C) and two Daraja apps; CredaFlow's per-tenant config must hold several credential sets, the initiator security credential, and a float-balance monitor (Account Balance API).
- Callbacks are unsigned and replayed: CredaFlow needs a per-tenant secret in the callback path, idempotency keyed on M-Pesa receipt/TransID, and a Transaction Status poll for missing callbacks.
- Lenders often go through an aggregator first because Daraja B2C approval and float management are the slow parts.

### Gaps
- No official Safaricom 2026 B2C tariff or Ratiba pricing; must come from a Safaricom Business Account Manager.
- Whether "Daraja 3.0" is an official Safaricom release name and what it changed: not confirmed from developer.safaricom.co.ke.
- Whether Safaricom approves Ratiba for lenders generally, or restricts it (e.g. CBK-licensed DCPs only): unknown.
- Aggregator pricing (Cellulant, Pesapal, Flutterwave, Kopo Kopo) for B2C/C2B: not found.

## 2. Bank rails: PesaLink, EFT, direct debit, check-off

### Takeaway
PesaLink (operated by IPSL, a KBA subsidiary, overseen by CBK) is the instant bank-to-bank rail; fees have collapsed to
free/KES 20 at most banks in 2026, but non-bank API access is limited, so fintechs reach it through banks or Paystack.
A modern, fintech-accessible Kenyan direct-debit mandate scheme comparable to DebiCheck was not found. Check-off
(payroll deduction) is the main "debit order" substitute for salaried borrowers and is capped by the Employment Act.

### Cited Findings
- IPSL is a wholly owned KBA subsidiary operating PesaLink; CBK regulates/oversees it; direct debits listed as a PesaLink instrument; "limited API for non-banks" (2021 case study, possibly stale) — [World Bank FPS PesaLink case study](https://fastpayments.worldbank.org/sites/default/files/2021-09/World_Bank_FPS_Kenya_PesaLink_Case_Study.pdf)
- >195 institutions on PesaLink incl. banks, SACCOs and fintech wallets; KCB, DTB, SBM, Ecobank adopted a flat KES 20 or lower — [TechTrendsKE, May 2026](https://techtrendske.co.ke/2026/05/20/banks-slash-pesalink-transfer-charges-kenya/)
- 19 banks charge KES 20 or nothing on PesaLink; Equity, Co-op and NCBA not among them — [tech-ish, Jul 2026](https://tech-ish.com/2026/07/22/pesalink-19-banks-flat-kes-20-transfers/)
- PesaLink connected to PAPSS for cross-border receipts (Feb 2026) — [TechCabal](https://techcabal.com/2026/02/26/pesalink-taps-papss-network/)
- Bank statement/transaction retrieval APIs (Equity, KCB, etc.) require a signed agreement and account relationship — [Upeosoft bank API guide](https://www.upeosoft.com/insights/bank-api-integration-kenya)
- Check-off: Employment Act s.19(3) caps total deductions. Secondary sources frame it as "deductions cannot exceed two-thirds of wages" or "employee must keep at least one-third"; some lenders apply the stricter one-third-of-basic-salary test — [Mwananchi Credit](https://mwananchicredit.com/check-off-loans-in-kenya); [Progressive Credit](https://progressivecr.co.ke/government-check-off-loans/)
- Public servants must retain at least one-third of basic salary after all commitments (public service HR policy manual); government deductions run through IPPD (Integrated Personnel and Payroll Database) — [Progressive Credit](https://progressivecr.co.ke/government-check-off-loans/); [PesaMarket payroll loans](https://pesamarket.com/en/payroll-loans)
- March 2026 draft Financial Consumer Protection Framework (CBK, CMA, CA) would require lenders, incl. fintechs and mobile money, to verify income, expenses and existing debt and document affordability before lending; status after April 2026 unconfirmed — [TechCabal, 21 Apr 2026](https://techcabal.com/2026/04/21/kenya-wants-lenders-to-prove-borrowers-can-repay-before-approving-loans/) (page 403 on fetch; snippet only)

### Inferences
- CredaFlow's DebiCheck/mandate module has no direct Kenyan analogue. Replace it with three collection modes: (a) Ratiba standing order, (b) check-off schedule export to an employer/IPPD with remittance reconciliation, (c) manual paybill/PesaLink payments with reconciliation.
- The check-off one-third rule maps closely onto CredaFlow's NDI affordability calc, but the base (gross vs basic) differs by employer, so make it tenant-configurable.
- If the affordability framework is adopted, CredaFlow's SA NCA-style affordability record is an asset in Kenya.

### Gaps
- Status of any KBA/KEPSS bank direct-debit mandate scheme for non-bank lenders in 2026: no source found.
- IPPD check-off code allocation process and fees for private lenders: not found.
- Employment Act s.19(3) statutory text was not fetched (kenyalaw.org); wording above is secondary.

## 3. Credit Reference Bureaus

### Takeaway
Three CBK-licensed CRBs: TransUnion Kenya, Metropol, Creditinfo Kenya. Monthly data submission (historically by the 10th),
negative-only sharing for non-banks unless the customer consents to positive sharing, and a KES 1,000 floor on NPL listing
under the 2020 regulations, whose legal status is clouded by a reported High Court nullification. No public
per-enquiry B2B price or public API spec was found.

### Cited Findings
- Exactly three licensed CRBs: TransUnion (formerly CRB Africa, licensed Feb 2010), Metropol (Apr 2011), Creditinfo — [Cytonn](https://cytonn.com/topicals/kenyas-credit-reference-1); [CBK Creditinfo press release](https://www.centralbank.go.ke/images/docs/media/Press%20Releases/CREDITINFOCRBKENYA.PDF); [CIS Kenya](https://ciskenya.co.ke/about-crbs/)
- CRB Regulations 2020 (Gazette Notice 55, 8 Apr 2020) replaced the 2013 regs; NPLs under KES 1,000 not to be submitted — [CBK press release Apr 2020](https://www.centralbank.go.ke/uploads/press_releases/850440997_Press%20Release%20-%20Credit%20Reference%20Bureau%20Regulations%20-%20April%202020.pdf)
- CBK withdrew approvals of unregulated digital (mobile) and credit-only lenders as third-party credit information providers to CRBs — [MarketScreener (CBK release)](https://www.marketscreener.com/news/latest/Publication-of-the-Credit-Reference-Bureau-Regulations-2020-and-Additional-Measures-on-Credit-Infor-30408328/)
- High Court reportedly nullified the Banking (CRB) Regulations 2020; appeal/stay status not found — [Wamae & Allen](https://wamaeallen.com/the-high-court-nullifies-the-banking-credit-reference-bureau-regulations-2020/)
- Non-bank institutions share negative information and must get customer consent before sharing positive information — [Cytonn](https://cytonn.com/topicals/kenyas-credit-reference-1)
- Monthly submission due by the 10th of the following month; the format is defined in the CRB Data Standards Manual (KBA, pre-2020) — [CBK/KBA Data Standards Manual](https://www.centralbank.go.ke/wp-content/uploads/2016/08/KBA-Data-Standards-Manual.pdf)
- Consumer prices: clearance certificate KES 2,200; one free credit report a year per bureau; USSD status checks KES 50–100 after the first — [Cytonn](https://cytonn.com/topicals/kenyas-credit-reference-1); [PesaMarket](https://pesamarket.com/en/blog/how-to-check-crb-status-kenya-2026) (consumer pricing, not lender B2B)
- Bureau FAQs: [Metropol](https://metropol.co.ke/faq/), [Creditinfo Kenya](https://creditinfo.co.ke/frequently-asked-questions-faq/)

### Inferences
- A lender must be a CBK-regulated entity (bank, MFB, SACCO via SASRA, or licensed DCP) to submit and probably to enquire; CredaFlow's CRB adapter is gated on the tenant's licence.
- Build one submission exporter against the CRB Data Standards Manual / CIS Kenya template (same file to all three bureaus) and per-bureau enquiry adapters; TransUnion Kenya likely shares tooling with TransUnion SA, but this is not confirmed.

### Gaps
- B2B cost per enquiry for each bureau: not public; requires sales quotes.
- Current CIS Kenya data template version and field list: the manual was located but not read.
- API docs (REST/SOAP) for Metropol/Creditinfo/TransUnion Kenya enquiry: not found publicly.
- Current legal status of CRB Regulations 2020 after the High Court ruling.

## 4. KYC / identity

### Takeaway
Private firms do not get direct IPRS access in practice; they go through vendors (Smile ID: IPRS + eCitizen + BRS,
36M+ records; also Youverify, deepidv, Didit, Prembly). Maisha Namba (9-digit UPI) runs alongside the 8-digit national ID,
and its rollout is contested and voluntary. No Safaricom API that matches an M-Pesa registered name to an ID number for
lenders was found; the only name signal is the payer name in C2B callbacks.

### Cited Findings
- Smile ID Kenya: access to 3 API authorities (IPRS, eCitizen, BRS), 36M+ ID records; supports National ID, KRA PIN, Alien Card, Passport — [Smile ID Kenya](https://smile.id/countries/kenya)
- Smile ID per-check pricing is not public (sales-quoted); a blog estimates USD 0.10–0.30 doc check, 0.30–1.00 biometric KYC (unverified) — [deepidv comparison](https://www.deepidv.com/compare/smile-identity); [helloduty](https://helloduty.com/blogs/what-is-smile-identity-and-how-its-revolutionizing-business-practices)
- IPRS is operated by NRB; individuals and private firms access it via vendors; ODPC enforces the Data Protection Act 2019 over ID verification — [Verifisha](https://verifisha.com/guides/iprs-checker-verify-kenyan-id); [Didit](https://didit.me/solutions/countries/kenya/)
- ID formats: 8-digit national ID or 9-digit Maisha Namba UPI (introduced late 2023) — [deepidv](https://www.deepidv.com/kenya-national-id-api)
- Maisha Namba status recorded as "Disputed" as of 19 Oct 2026; pilot began Nov 2023; registration voluntary per officials — [bordercontracts.org](https://bordercontracts.org/contracts/kenya-maisha-namba-digital-id/); [CFI report](https://www.centerforfinancialinclusion.org/wp-content/uploads/2024/08/Citizen-Experiences-with-DPI-in-Kenya-Web.pdf)
- Youverify advertises IPRS, eCitizen and BRS checks incl. Maisha Card and KRA PIN, framed against POCAMLA KYC duties — [Youverify](https://youverify.co/en/blogs/kyc-pocamla-compliance-kenya)
- KRA PIN consumer checkers charge KES 15–20 per lookup via M-Pesa — [krachecker.co.ke](https://krachecker.co.ke/); [TaxHub](https://taxhubke.com/verify/pin-by-id)
- No Daraja endpoint found for name/ID matching; Safaricom KYC is part of merchant onboarding — [dev.to setup guide](https://dev.to/eric_muturi/requirements-for-m-pesa-online-payment-setup-in-kenya-2025-guide-2bjl); [Safaricom LNM requirements](https://www.safaricom.co.ke/images/Downloads/Lipa-na-mpesarequirements.pdf)

### Inferences
- The SmileIdentity adapter carries over with a country switch (`KE`, id_type NATIONAL_ID / KRA_PIN / ALIEN_CARD); support both 8- and 9-digit identifiers in validation.
- The usual phone-to-ID check is a borrower-initiated KES 1 STK Push and comparison of the callback name with the IPRS name. That is a pattern, not an API, and it is unconfirmed here.

### Gaps
- Official private-sector IPRS access terms/fees from NRB or the State Department for Immigration: none found.
- Whether Safaricom sells an MSISDN-to-ID KYC match or SIM-swap check to lenders in Kenya: not found.

## 5. Alternative data / statement analysis

### Takeaway
The M-Pesa PDF statement is the de facto affordability input, and vendors parse it (Prembly takes a base64 PDF and has
a scoring endpoint). Daraja provides no statement or transaction-history API, so the customer-uploaded PDF is the
route, which mirrors CredaFlow's bank-statement upload.

### Cited Findings
- Prembly M-Pesa Statement Analysis API: base64 PDF + customer details in, four feature endpoints incl. credit scoring; methodology undocumented — [Prembly docs](https://docs.prembly.com/docs/m-pesa-statement-analysis)
- Early-stage open-source M-Pesa statement + eTIMS parser (synthetic sample only, not production evidence) — [kenya-agent-tools](https://github.com/milan2307/kenya-agent-tools)
- Daraja covers payments, transaction queries and balances, not statements — [api-evangelist/mpesa](https://github.com/api-evangelist/mpesa)
- SMS-based M-Pesa message parsing example (Python), relevant for classification taxonomy — [Medium](https://medium.com/@kaluwanjala/using-python-to-extract-useful-information-from-m-pesa-messages-for-analysis-f4bd6e9d340e)

### Inferences
- CredaFlow's VLM/OCR statement pipeline extends to M-Pesa: the layout is standard and machine-generated PDFs are usually password-protected with a code sent by SMS (from general knowledge, unverified here). The classification taxonomy differs: paybill/till/Fuliza/send-money/agent withdrawal. Fuliza (overdraft) use and existing digital loans are key affordability signals.
- Reading SMS inboxes on the device (phone data) runs into Data Protection Act consent rules and the CBK DCP regime. This was not verified here, so treat it as high-risk.

### Gaps
- No independent accuracy benchmarks for M-Pesa statement parsers; no evidence on PDF tamper rates in Kenya.
- Rules on mobile phone data (contacts, SMS) use by lenders under ODPC/CBK in 2026: not covered in this pass.

## 6. Messaging: SMS, sender IDs, USSD, WhatsApp

### Takeaway
Africa's Talking is the default Kenyan SMS/USSD API. Bulk SMS costs roughly KES 0.3–0.8 per message, and sender IDs must
be registered per network before use (2–5 business days; the fee is unclear and sources conflict). No source covered
USSD shortcode costs or CA rules on sender IDs.

### Cited Findings
- Africa's Talking Kenya rates by carrier, e.g. KES 0.8 Airtel local; page states both "$35 setup fee for Sender IDs" and "registration currently free" (self-contradictory) — [Africa's Talking pricing](https://africastalking.com/pricing) (403 on fetch; snippet)
- Older AT help article: sender ID one-off KES 7,500 + 16% VAT via M-Pesa, processing time varies by network (~6.5 years old, likely stale) — [AT help](https://help.africastalking.com/en/articles/407085-how-do-i-set-up-my-sender-id-in-kenya-or-uganda)
- 2026 guide: ~KES 0.80 standard rate with volume tiers; registration 2–5 business days, needs a company letter; unregistered IDs get dropped or replaced by operators — [helloduty AT guide](https://helloduty.com/blogs/sending-bulk-sms-via-africas-talking-api); [helloduty vendor comparison](https://helloduty.com/blogs/top-sms-systems-in-kenya)
- Kenyan bulk SMS gateway comparison — [Techweez, Aug 2025](https://techweez.com/2025/08/26/top-6-affordable-bulk-sms-api-gateways-in-kenya/)

### Inferences
- CredaFlow's BulkSMS adapter becomes an Africa's Talking adapter, with a per-tenant sender ID. SMS is off by policy in CredaFlow (lib/messaging/.claude.md), and that policy should be reconsidered for Kenya, where SMS and USSD are primary channels.
- USSD (session-based menus via AT or Safaricom) matters for feature-phone borrowers; it would be a new channel in CredaFlow, not a mapping.

### Gaps
- USSD shortcode setup/monthly fees and per-session pricing: not found.
- CA (Communications Authority) rules on promotional vs transactional SMS, opt-out (e.g. STOP codes), DND: not found.
- WhatsApp Business adoption by Kenyan lenders and debt-collection messaging rules: not researched.

## 7. E-signatures and electronic contracts

### Takeaway
KICA (as amended, incl. Business Laws (Amendment) Act 2020) recognises electronic signatures. "Advanced" electronic
signatures equal handwritten ones only when backed by a CA-licensed certification service provider. Loan agreements can
be signed electronically, but negotiable instruments such as promissory notes cannot (s.83B KICA).

### Cited Findings
- KICA recognises advanced electronic signatures and records as equal to written ones — [KE-CIRT/CA FAQ](https://ke-cirt.go.ke/faqs/)
- Certification service providers must be licensed by the Communications Authority; advanced e-signatures from unlicensed/unrecognised CSPs are invalid — [Kaplan & Stratton](https://www.kaplanstratton.com/wp-content/uploads/2022/03/Legal-Recognition-of-Electronic-Signatures-in-Kenya.pdf); [kn.co.ke](https://kn.co.ke/an-overview-of-electronic-signing-in-kenya/)
- Negotiable instruments (promissory notes, cheques) must be hard copy under s.83B KICA; loan agreements not structured as negotiable instruments can be e-signed — [Snnyaga Advocates](https://snnyagaadvocates.co.ke/e-signatures-in-kenya-how-to-legally-digitize-your-transactions-in-2025); [Ndikimi & Co](https://ndikimi.com/commercial-law-legal-guide-to-electronic-contracts-signatures/)
- Ordinary e-signatures valid for most commercial contracts without certification (vendor view) — [firma.dev](https://firma.dev/e-signature-legality/kenya); [BoldSign](https://boldsign.com/electronic-signature-legality/kenya/)
- Older (2020) report: only 2 licensed CSPs, not yet issuing advanced signatures — [DLA Piper Africa / IKM](https://www.dlapiperafrica.com/en/kenya/insights/2020/what-it-means-to-use-electronic-signatures.html) (stale)

### Inferences
- CredaFlow's simple e-sign (OTP + audit trail + hashed PDF) is likely adequate for loan agreements. Avoid promissory notes in the document pack, and get Kenyan counsel's sign-off on templates (NCA wording does not apply).

### Gaps
- Current list of CA-licensed CSPs (2026): not found.

## 8. Hosting and data residency

### Takeaway
As of July 2026 no hyperscaler runs a cloud region in Kenya. The nearest are AWS af-south-1 (Cape Town) and Azure South
Africa. The AWS Nairobi Local Zone is announced but not generally available, OCI Nairobi (via iXAfrica) has no date, and
the Microsoft/G42 Olkaria project was paused in May 2026. Localisation is mandatory only for "strategic interest"
data. Hosting elsewhere is a cross-border transfer under the Data Protection Act, governed by ODPC Guidance Notes issued
8 Sep 2026.

### Cited Findings
- No hyperscaler region in Kenya (Jul 2026); AWS: 3 CloudFront edges in Nairobi, Local Zone af-south-1-nbo-1a "announced, not GA"; Google: no region, Mombasa edge; Azure: none; OCI Nairobi via iXAfrica announced 27 Jan 2026, no launch date; Microsoft/G42 Olkaria $1bn DC paused May 2026 (60 MW EcoCloud continues) — [Lineserve data centre list 2026](https://www.lineserve.net/blog/datacenters-in-kenya) (vendor blog)
- Local colocation: iColo/Digital Realty (NBO1/NBO2, MBA1/MBA2), Africa Data Centres NBO1, iXAfrica NBOX1, PAIX, Safaricom Thika and Red Hill (Tier III), Telkom, Konza (government); Lineserve runs a Nairobi cloud region ke-1a — [Lineserve](https://www.lineserve.net/blog/datacenters-in-kenya)
- Grid tight: Jan 2026 peak 2,439 MW vs 2,495 MW firm capacity (2.3% reserve) — [Lineserve](https://www.lineserve.net/blog/datacenters-in-kenya)
- DPA s.50 / Reg 26: "strategic interest" data (civil registration, elections, public finance, protected systems, education, health) needs Kenyan servers or a serving copy in Kenya; other data may leave, but cloud hosting abroad is a cross-border transfer; ODPC Cross-border Transfer Guidance Notes published 8 Sep 2026 — [Covington Africa, Sep 2026](https://www.covafrica.com/2026/09/kenya-issues-new-cross-border-data-transfer-guidance-familiar-concepts-but-important-local-differences/); [TL Advocates](https://tladvocates.com/2026/10/01/odpcs-latest-guidelines/); [TechAfrica News](https://techafricanews.com/2026/10/19/how-kenyas-new-data-guidance-addresses-global-transfers/)
- Kenya Cloud Policy 2025 implementation guidelines (Jun 2026) apply to all entities using data emanating from Kenya; exemptions via a cloud adoption committee — [ICT Ministry PDF](https://www.ict.go.ke/sites/default/files/2026-07/Final%20%20Kenya%20Cloud%20Policy%202025%20Implementation%20Guidelines.pdf)
- ODPC pushing mandatory local storage for transport/booking apps (fines up to KES 5m), described elsewhere as proposed — [Techweez, Apr 2026](https://techweez.com/2026/04/17/odpc-transport-local-data-storage/)

### Inferences
- CredaFlow's one-instance-per-lender model fits: a Kenyan lender can run on a Nairobi VPS/colo (Lineserve, Safaricom, iColo) or offshore with cross-border transfer documentation. Lending data is not listed as "strategic interest", but CBK outsourcing/data rules for licensed lenders were not checked and may be stricter.
- Daraja's callbacks need a public HTTPS endpoint, which works from any location.

### Gaps
- CBK prudential guidelines on outsourcing/cloud for banks, MFBs and DCPs (whether CBK requires local hosting or approval): not researched.
- Safaricom's own public cloud offering (vs colocation): not confirmed.
- ODPC registration of data controllers/processors (lenders must register) and its fees: not covered here.
