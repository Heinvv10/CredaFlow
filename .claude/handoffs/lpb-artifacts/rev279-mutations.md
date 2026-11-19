# PR 279 mutations at 9bd1ed95

75 run: 53 killed, 22 survived. Run stopped early at the lead's request.

Suites: lib/non-nca-documents, lib/affordability, DisburseForm, lib/jurisdiction, lib/security, lib/registry, lib/audit, disburse and decide route tests; then ls-payout and ls-end-to-end integration on PostgreSQL 16.

**Unrun:** C10 catch rethrows, C11 premium periods, C12 NCA bureau skipped, R1 route drops bankRef, R2 route hook removed, R3 response drops precondition, R4 response status 200, R5 drops affordabilitySnapshot, R6 drops payout note, V1 verification route READONLY, V2 verification guard off, V3 verification status 200, X1 decide EFT refusal off, X2 documentProblem off the tx. The harness may have started C10 when stopped; no result was recorded.

| Mutant | File | Result | Killed by |
|---|---|---|---|
| D1 regime check removed | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D2 pre-tx status check removed | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × books once: a second disbursement of the same application is refused 669ms; FAIL  lib/non-nca-documents/ |
| D3 bank ref not required | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × a manual transfer needs its bank reference: missing, blank, over-long and non-text ones book nothing 613 |
| D4 segregation refusal off | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × is refused for the approver (segregation of duties), and books nothing 671ms; FAIL  lib/non-nca-document |
| D5 screening refusal off | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × is refused when the borrower is screened out 685ms; FAIL  lib/non-nca-documents/ls-end-to-end.integratio |
| D6 locked approval refusal off | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × the frozen approval binds at payout: the borrower's finances, the policy, or the stored terms changed af |
| D7 KYC doc FOR SHARE removed | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × holds the KYC and statement documents FOR SHARE: a writer on the document row alone is waited for 422ms; |
| D8 re-read outside tx | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × approves, issues, acknowledges, signs and books the loan: the schedule is the one the agreement printed, |
| D9 signature check off | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × is refused before the borrower has signed, and when a document changed after signing 353ms; FAIL  lib/no |
| D10 document problem off | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × is refused before the borrower has signed, and when a document changed after signing 682ms; FAIL  lib/no |
| D11 kycStatus term dropped | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D12 composite kyc term dropped | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D13 deceased off | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × a borrower recorded as deceased after approval is not paid 536ms; FAIL  lib/non-nca-documents/ls-payout. |
| D14 bankDetails null check off | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D15 statement check off | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × is refused without verified payout banking: no bank record, then a statement for another account 731ms;  |
| D16 second-person check off | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × a second person records the payout account, audited, and the disburser cannot be that person 473ms; × a  |
| D17 start-date check off | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × is refused after the agreement's start date, and the way back works: return to review, approve, sign aga |
| D18 EFT backstop off | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D19 claim drops updatedAt | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D20 claim count check off | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D21 Loan.startDate = first due date | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D22 schedule feesDue zeroed | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D23 commission not recorded | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D24 LOAN_CREATED action swapped | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × approves, issues, acknowledges, signs and books the loan: the schedule is the one the agreement printed, |
| D25 LOAN_DISBURSED action swapped | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × approves, issues, acknowledges, signs and books the loan: the schedule is the one the agreement printed, |
| D26 SET CONSTRAINTS removed | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D27 serialization not mapped to 409 | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × an account changed under the lock is not paid: the payout loses the race and books nothing 1316ms; × wit |
| D28 isolation ReadCommitted | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × an account changed under the lock is not paid: the payout loses the race and books nothing 1374ms; × wit |
| D29 bank ref not stored | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × approves, issues, acknowledges, signs and books the loan: the schedule is the one the agreement printed, |
| D30 kyc_changed mapping removed | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × is refused when a KYC document stopped being verified after approval 370ms; × KYC at payout is VERIFIED: |
| D31 application_changed mapping removed | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D32 monthlyServiceFee zeroed | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D33 disbursement bank name not stored | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × approves, issues, acknowledges, signs and books the loan: the schedule is the one the agreement printed, |
| D34 agreementDocId null | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D35 interestRatePm zero | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D36 contractualTotalRepayable zero | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D37 bank detail error not mapped | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × is refused without verified payout banking: no bank record, then a statement for another account 554ms;  |
| D38 database refusal not mapped | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| D39 audit: payout reference dropped | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × approves, issues, acknowledges, signs and books the loan: the schedule is the one the agreement printed, |
| D40 audit: verifier dropped | `lib/non-nca-documents/disburse.ts` | KILLED | IT: × approves, issues, acknowledges, signs and books the loan: the schedule is the one the agreement printed, |
| D41 notification not sent | `lib/non-nca-documents/disburse.ts` | SURVIVED |  |
| P1 note not required | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × is refused without a complete bank record or a note saying how 6ms; FAIL  lib/non-nca-documents/payout |
| P2 application lock removed | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × takes the application and client evidence locks, binds the account and audits who did it 7ms; FAIL  li |
| P3 client lock removed | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × takes the application and client evidence locks, binds the account and audits who did it 8ms; FAIL  li |
| P4 regime check off | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × is refused for an NCA application, which has AVS, and writes nothing 6ms; FAIL  lib/non-nca-documents/ |
| P5 status check off | `lib/non-nca-documents/payout-account.ts` | KILLED | IT: × a confirmation is of one account: a change after it voids it, and it is recorded only for an approved ke |
| P6 complete-bank check off | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × is refused without a complete bank record or a note saying how 7ms; FAIL  lib/non-nca-documents/payout |
| P7 fingerprint constant | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × takes the application and client evidence locks, binds the account and audits who did it 11ms; FAIL  l |
| P8 audit action swapped | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × takes the application and client evidence locks, binds the account and audits who did it 10ms; FAIL  l |
| P9 passed false | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × takes the application and client evidence locks, binds the account and audits who did it 11ms; FAIL  l |
| P10 provider check dropped | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × is refused for none, another application, a changed account, a provider's result or an unnamed confirm |
| P11 gate dropped | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × is refused for none, another application, a changed account, a provider's result or an unnamed confirm |
| P12 unnamed confirmer allowed | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × is refused for none, another application, a changed account, a provider's result or an unnamed confirm |
| P13 disburser may confirm | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × is refused for the disburser, whatever else holds 14ms; FAIL  lib/non-nca-documents/payout-account.tes |
| P14 earliest not latest | `lib/non-nca-documents/payout-account.ts` | KILLED | IT: × a second person records the payout account, audited, and the disburser cannot be that person 991ms; FAIL |
| P15 any application's row | `lib/non-nca-documents/payout-account.ts` | SURVIVED |  |
| P16 note not stored | `lib/non-nca-documents/payout-account.ts` | SURVIVED |  |
| P17 checkedById not stored | `lib/non-nca-documents/payout-account.ts` | KILLED | unit: × takes the application and client evidence locks, binds the account and audits who did it 9ms; FAIL  li |
| T1 empty ref allowed | `lib/non-nca-documents/payout-terms.ts` | KILLED | unit: × is required, trimmed, a single line and bounded 5ms; FAIL  lib/non-nca-documents/payout-terms.test.ts  |
| T2 ref max off by one | `lib/non-nca-documents/payout-terms.ts` | KILLED | unit: × is required, trimmed, a single line and bounded 5ms; FAIL  lib/non-nca-documents/payout-terms.test.ts  |
| T3 control chars allowed | `lib/non-nca-documents/payout-terms.ts` | KILLED | unit: × is required, trimmed, a single line and bounded 11ms; FAIL  lib/non-nca-documents/payout-terms.test.ts |
| T4 ref not trimmed | `lib/non-nca-documents/payout-terms.ts` | KILLED | unit: × is required, trimmed, a single line and bounded 5ms; × a manual payout says so and holds the button un |
| T5 note min off by one | `lib/non-nca-documents/payout-terms.ts` | KILLED | unit: × says how the account was confirmed, within bounds 3ms; FAIL  lib/non-nca-documents/payout-terms.test.t |
| T6 note max off by one | `lib/non-nca-documents/payout-terms.ts` | SURVIVED |  |
| T7 payable any day after | `lib/non-nca-documents/payout-terms.ts` | KILLED | unit: × refuses a later day and an earlier one, today whatever the day of the month 5ms; FAIL  lib/non-nca-doc |
| T8 payable by UTC day | `lib/non-nca-documents/payout-terms.ts` | KILLED | unit: × is the one SAST day it can be paid out, whichever UTC day that spans 5ms; FAIL  lib/non-nca-documents/ |
| C1 approvedAmount term dropped | `lib/affordability/current-approval.ts` | KILLED | unit: × refuses approved terms on the application that differ from the frozen approval 11ms; FAIL  lib/afforda |
| C2 approvedTermDays term dropped | `lib/affordability/current-approval.ts` | KILLED | unit: × refuses approved terms on the application that differ from the frozen approval 10ms; FAIL  lib/afforda |
| C3 initiationFeePayment term dropped | `lib/affordability/current-approval.ts` | KILLED | unit: × refuses approved terms on the application that differ from the frozen approval 10ms; FAIL  lib/afforda |
| C4 key facts asked for bureau | `lib/affordability/current-approval.ts` | KILLED | unit: × holds with neither a bureau check nor a PASQ 9ms; × refuses the frozen terms altered after approval (t |
| C5 keyFacts always false | `lib/affordability/current-approval.ts` | KILLED | unit: × holds with neither a bureau check nor a PASQ 9ms; × refuses the frozen terms altered after approval (t |
| C6 absent regime reads key facts | `lib/affordability/current-approval.ts` | KILLED | unit: × an NCA application is still asked for both 12ms; × rejects downstream progression when approval is not |
| C7 pricing failure ignored | `lib/affordability/current-approval.ts` | KILLED | unit: × refuses the frozen terms altered after approval (the snapshot no longer hashes to itself) 8ms; × refus |
| C8 schedule from now | `lib/affordability/current-approval.ts` | SURVIVED |  |
| C9 frozen read failure not refused | `lib/affordability/current-approval.ts` | KILLED | unit: × refuses the frozen terms altered after approval (the snapshot no longer hashes to itself) 4ms; FAIL  l |
