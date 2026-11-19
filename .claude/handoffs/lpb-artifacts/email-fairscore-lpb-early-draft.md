<!-- DRAFT ONLY. Do not send; Hein sends. Clause numbers checked against bid.txt on 2026-11-01. -->

Subject: Lesotho PostBank LMS tender (LPB/0009/2026): what we need from Fair Score by 5 Nov

Hi Pramod, Dr Danny,

Bids close 25 November at 12:00 CAT, and questions to the bank close 12 November at 16:30 CAT. The bid is scored pass/fail line by line, and "Comply" without evidence counts as not complying. These items can only come from Fair Score, so please send them by 5 November if you can:

1. ISO/IEC 27001 (item 4.9): your current certificate and its scope. It must be held by the bidder or the software publisher. If yours doesn't cover software delivery, or Fair Score's certificate may not count for the JV, we need to know now.
2. References (item 7.1): reference letters with client contacts from banks or regulated institutions where an LMS was implemented in the last five years. At least one must integrate with core banking through APIs. On our side we only have Ndzinga Capital. It also matters for item 1.2, which needs the offered version live at a bank or regulated institution by bid closing: Ndzinga runs the parent codebase, not CredaFlow itself, so if you have a live LMS client who could count, we need to know.
3. Key people (item 7.3), signed CVs and certificates:
   - Project Manager: ICT or business degree, PMP or PRINCE2, 5 years, 2 LMS or core banking projects
   - Security Lead: CISSP, CISM or CISA, 3 years in financial services security
   - Integration Lead, if you have one: ICT or computer science degree, 5 years, 2 REST integrations with core banking
4. PCI DSS (item 4.1): do you hold an attestation or work with a QSA? PCI has no "or equivalent", and any deviation is a Fail. Our plan is on-premise at the bank, which needs a QSA-reviewed responsibility matrix, so a QSA must be engaged soon. That has a cost we need to agree.
5. JV paperwork: a JV agreement or binding letter of intent, powers of attorney (notarised if signed outside Lesotho), a signed bid securing declaration, and each party's section 3.2 documents. Please also confirm how the tender document was obtained. Bidders who didn't get it directly from LPB are rejected (clause 6.3).
6. Performance security: an on-demand guarantee from a Lesotho bank, or a foreign bank through a Lesotho correspondent, due within 21 days of signing. Who would arrange it?

Where the software stands: Maloti and Lesotho support, IFRS 9 provisioning, a configurable rules engine, approval workflows, single sign-on, a tamper-evident audit trail and Kubernetes deployment are built. We are finishing a Lesotho loan from application to arrears, which we need for a live demo.

The shortcomings you should know about:

- Drag-and-drop process designer (2.9.5): we do not have one and it is at real risk.
- Microservices (5.2): CredaFlow is a modular monolith in containers. Named technologies are read as "or equivalent", but we must show equivalence, so we want to ask the bank.
- Core banking API: we can't finish this without the bank's interface details, so it goes on the question list.
- Penetration test: an independent one still has to be commissioned. If you have a firm you'd use, please tell us.
- PCI, tokenization and encryption keys: we hold no PCI evidence, sensitive data is not yet tokenized in a vault, and keys are not in an HSM or KMS. Any deviation here is an automatic Fail.
- API documentation: only a small share of our routes are in OpenAPI today, and REST deviations are also an automatic Fail.
- Performance and disaster recovery: no benchmark at 500,000 accounts and no tested failover yet.

Our own line-by-line scoring today says the bid would fail on all six criteria. Items 1.2 and 7.1 decide whether it can pass at all, and no build fixes them. So before we spend on PCI, a vault or a penetration test, we need your straight answer: do you have a live LMS client and three references that would count? If not, we should talk about whether to bid.

Are you happy for us to send clarification questions to the bank in the JV's name before 12 November? And can we have a call this week?

Regards,
Hein
