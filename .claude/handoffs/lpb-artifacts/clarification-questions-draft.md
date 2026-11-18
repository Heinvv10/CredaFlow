<!-- DRAFT ONLY. Do not send; Hein sends, and Fair Score should agree it first because the JV is the bidder. -->
<!-- Send to erptender@lpb.co.ls by 12 Nov 2026 16:30 CAT (ITB 7). -->

# LPB LMS tender: clarification questions

**Tender documents**

1. **Reference number.** The cover and invitation use LPB/0009/2026. The Bid Data Sheet (ITB 1.1), Sections 3 and 6 and later forms use LPB/001/2026, and one heading uses LPB/009/2026. Which number should appear on the bid and on the sealed envelope?
2. **Bid opening time and validity.** The invitation closes bids at 12:00 noon CAT on 25 November 2026 but opens them at 10:00 CAT, before closing; the Bid Data Sheet gives 12:00 noon. Please confirm 12:00 for both. The invitation also says bid securing declarations must be valid until 15 April 2027, while ITB 21.3 says 25 May 2027. Which date applies?
3. **Pre-bid meeting.** Invitation paragraph 7 says there shall be a pre-bid meeting or site visit. The schedule of activities says N/A. Will one be held? If so, when?
4. **Margin of preference.** ITB 35.1 says a margin applies under Section 3. How is it calculated for a joint venture with mixed shareholding?

**Joint venture and experience**

5. **ISO/IEC 27001 (item 4.9).** The certificate must be held by the Bidder or the software publisher. In a joint venture, does a certificate held by one member satisfy this?
6. **Experience (item 7.1).** May the three implementations be combined across joint venture members?
7. **Live production (item 1.2).** The offered version must be in live production at a bank or regulated financial institution at bid closing. Does a live deployment of the same core platform under a different product name or configuration satisfy this?
8. **Software Publisher's Authorisation (item 7.2, BDS "Certificate of Authorisation").** If one JV member publishes the software, is the authorisation still required?

**Architecture**

9. **Microservices (items 5.2, 5.5).** Section 3 reads named technologies as "or equivalent". Will the Bank accept a modular application in OCI containers on Kubernetes, with independently scaled web, worker and integration workloads and rolling updates, as an equivalent? What evidence would it want?
10. **Database (item 5.16).** Does PostgreSQL with a paid support contract, or a cloud-managed PostgreSQL service, satisfy "commercially supported"?
11. **Deployment model.** Does the Bank prefer on-premise, public cloud tenancy or managed service? If on-premise, what container platform does it run, and who supplies the HSM (item 4.4) and the infrastructure for the Production, DR, UAT and Training environments (item 5.10)?

**Integration**

12. **Core banking and ERP (items 3.2, 3.4).** Which core banking and ERP systems and versions does the Bank run? Do they already expose REST APIs? Will specifications be available before bid closing, or at contract? If the core system has no API, who provides the adapter?
13. **Digital channels (item 3.3).** Which internet banking, mobile and USSD platforms are in use, and do they call out to the LMS or the reverse?
14. **Third parties (items 2.2.2, 2.3.3, 3.5).** Which credit bureau(s), mobile money operators, sanctions/PEP list provider and SMS gateway does the Bank use, and does the Bank hold those contracts?
15. **Lesotho ID.** What format and check rules apply to the national ID and passport numbers the system must capture?

**Security and PCI**

16. **Cardholder data (items 4.1, 4.2).** Will the LMS store, process or transmit PANs at all? If repayments and disbursements run only through core banking accounts, is PCI DSS evidence route (b) with no PAN in scope acceptable?
17. **Penetration test (T3).** The summary must be less than 12 months old. Is a test commissioned before bid closing on the offered version required, or may it follow award if the bid names the tester and date?

**Regulatory and functional**

18. **Central Bank of Lesotho formats (items 2.8.2, 2.8.3).** Please supply the required classification reports, formats and the non-performing interest suspension rules, or cite the directive.
19. **Customer documents.** Are there mandated wordings for loan agreements, key facts statements and arrears letters in Lesotho, or will the Bank supply its own templates?
20. **Low-code designer (item 2.9.5).** Must all listed flows be drag-and-drop, or does a configuration interface with version control, a test environment and maker-checker approval qualify for rules, forms and notifications, given that these are read as benchmarks?
21. **Mortgage (item 2.1.1).** Are mortgage products required at go-live or in a later phase? Will the Bank state the expected volumes per product?

**Commercial**

22. **Currency.** ITB 15.1 sets maloti or rand by origin. For a JV with supplies from both, which applies?
23. **Data migration (item 6.2).** What is the existing system, how many active and closed loans must migrate, and is data extraction the Bank's responsibility?
24. **Delivery schedule.** The Delivery and Completion Schedule in Section 6 has no stated periods. What is the required go-live date?
