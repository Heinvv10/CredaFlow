// lib/integrations/collections/__fixtures__/netcash-avs-response.ts
/**
 * Transcribed from Netcash's public developer docs. Do not hand-edit field
 * names — if the vendor changes the contract, re-fetch and re-transcribe.
 *
 * Sources (fetched 2026-07-10):
 *  - https://api.netcash.co.za/value-added-services/avs-real-time/
 *    (human-readable doc: endpoint, method name, mandatory/optional
 *    parameter list, error codes, and the XML response samples below —
 *    transcribed verbatim, including the vendor's use of `isNull="true"`
 *    on absent fields).
 *  - https://api.netcash.co.za/ws-methods/
 *    (confirms AVSRealtimeQuery lives on the NIF entry point:
 *    https://ws.netcash.co.za/NIWS/NIWS_NIF.svc)
 *  - https://ws.netcash.co.za/NIWS/NIWS_NIF.svc?singleWsdl
 *    (the live WSDL for that exact endpoint — fetched directly, not from
 *    training data. Neither doc page publishes a full SOAP request
 *    envelope or a SOAPAction header, so the WSDL is the only source for
 *    those two facts. It also gives the authoritative wire ORDER of
 *    request parameters, which differs slightly from the doc's table
 *    order, and confirms IsIdNumber is xs:boolean and BankAccountType is
 *    an enum, not free text.)
 *
 * DEVIATIONS from the task-4-brief's assumptions:
 *  - Endpoint casing: the doc's "Technical Information" section (the
 *    authoritative one — matched by ws-methods.html and the WSDL's
 *    <soap:address>) is `https://ws.netcash.co.za/NIWS/NIWS_NIF.svc`.
 *    Matches the brief's assumption.
 *  - Service key IS the first argument, per both the doc's "Mandatory
 *    fields" table and the WSDL's <ServiceKey> being the first child of
 *    the <AVSRealtimeQuery> request element. Matches the brief.
 *  - SOAPAction header (not published on either doc page — sourced from
 *    the live WSDL): `http://tempuri.org/INIWS_NIF/AVSRealtimeQuery`.
 *  - Request element order per the WSDL (this is what the wire module
 *    emits — the doc's table lists mandatory-then-optional and doesn't
 *    match this order):
 *    ServiceKey, AccountReference, Extra1, Extra2, Extra3,
 *    BankAccountNumber, BranchCode, BankAccountType, EnquiryName,
 *    Initials, IdNumber, IsIdNumber, PhoneNumber, Email.
 *  - BankAccountType is the WSDL enum `MandateOptions.BankAccountType`:
 *    "Current" | "Savings" | "Transmission" — NOT "CHEQUE"/"SAVINGS".
 *    The wire module maps our AvsRequest.accountType onto it
 *    (CHEQUE -> "Current", SAVINGS -> "Savings").
 *  - AccountReference: the doc marks this "mandatory" but our AvsRequest
 *    (Task 1) has no reference/correlation field. Not specified by any
 *    doc source — the wire module fills it with the ID number (already
 *    part of the payload, so no new PII exposure) as a judgment call,
 *    not a transcription.
 *
 * Response field names, from the doc's XML sample and cross-confirmed by
 * the WSDL's AVSRealtimeQueryResponse complex type (same order, same
 * names): AcceptsCredits, AcceptsDebits, AccountActive, AccountDormant,
 * BankAccountNumberValid, EmailMatch, FileToken, IdNumberMatch,
 * InitialMatch, LastNameMatch, Messages, OfflineRequest, PeriodActive,
 * PhoneNumberMatch, TaxRefMatch, ErrorCode.
 *
 * Mapping onto our provider-agnostic AvsChecks (Task 1) — the doc does
 * not spell out a 1:1 mapping, this is our inference:
 *   checks.accountActive    <- AccountActive
 *   checks.acceptsDebits    <- AcceptsDebits
 *   checks.idNumberMatch    <- IdNumberMatch
 *   checks.lastNameMatch    <- LastNameMatch      (surname match)
 *   checks.openThreeMonths  <- PeriodActive       (best-fit inference —
 *     the doc gives no per-field prose description of PeriodActive, but
 *     it's the only response field describing account tenure/activity
 *     period, and the doc's field name literally says "period active")
 * All other response fields (AcceptsCredits, AccountDormant,
 * BankAccountNumberValid, EmailMatch, InitialMatch, PhoneNumberMatch,
 * TaxRefMatch, FileToken, Messages, OfflineRequest) have no home in
 * AvsChecks; they're preserved only via the raw XML string on AvsResult.
 *
 * Response values are the string enum `AVSOptions.MatchIndicator`
 * ("Valid" | "Invalid" | "NotApplicable") per the WSDL, or the element is
 * missing / self-closed with `isNull="true"` when the bank returned
 * nothing. The wire module maps Valid -> true, Invalid -> false, and
 * NotApplicable / missing / null -> null (fail-closed per the spec's
 * pass rule for the three required checks).
 *
 * Error codes (doc, "Output" table — the doc frames these as the service
 * responding "with the information returned from the bank OR with one of
 * the error codes listed below", i.e. only 000 carries bank data):
 *   000 - Enquiry Successful
 *   100 - Authentication failed
 *   200 - General service error. Contact support
 *   203 - SA ID number, Bank account number, Branch code or Bank account
 *         type invalid. Error description is returned in <Messages/>.
 *
 * ErrorCode handling in the wire module (our policy; the doc lists the
 * codes but doesn't classify them):
 *   000       -> enquiry ran; parse the checks into a business-shaped
 *                AvsResult. A genuine failed verification is a 000
 *                response with Invalid fields (the doc's own 000 sample
 *                carries <InitialMatch>Invalid</InitialMatch>).
 *   100 / 200 / 203 / anything else / missing
 *             -> the enquiry never completed (bad or rotated service key,
 *                Netcash outage, input that failed Netcash's local CDV
 *                validation before reaching the bank — the doc's 203
 *                samples show ALL check fields isNull). These throw
 *                CollectionProviderError("PROVIDER_ERROR") with the code
 *                and the <Messages/> text. Returning passed=false here
 *                would make a vendor outage or a typo'd account number
 *                indistinguishable from "the bank checked and said no".
 */

/** Verbatim from the doc's "XML response example" (ErrorCode 000). */
export const SAMPLE_SUCCESS_XML = `<AVSRealtimeQuery>
<MethodParameters>
<AVSRealtimeQueryResponse>
<AcceptsCredits>Valid</AcceptsCredits>
<AcceptsDebits>Valid</AcceptsDebits>
<AccountActive>Valid</AccountActive>
<AccountDormant>NotApplicable</AccountDormant>
<BankAccountNumberValid>Valid</BankAccountNumberValid>
<EmailMatch>Valid</EmailMatch>
<FileToken>RT.10029177.1000807447.0254.63430</FileToken>
<IdNumberMatch>Valid</IdNumberMatch>
<InitialMatch>Invalid</InitialMatch>
<LastNameMatch>Valid</LastNameMatch>
<Messages attr0="StringArray" isNull="false" />
<OfflineRequest>False</OfflineRequest>
<PeriodActive>Valid</PeriodActive>
<PhoneNumberMatch>Valid</PhoneNumberMatch>
<TaxRefMatch>NotApplicable</TaxRefMatch>
<ErrorCode>000</ErrorCode>
</AVSRealtimeQueryResponse>
</MethodParameters>
</AVSRealtimeQuery>`

/**
 * Verbatim from the doc's "Error message examples" -> "Account number CDV
 * fails" (ErrorCode 203). All match/verify fields are absent
 * (`isNull="true"`) — the enquiry failed Netcash's local validation and
 * never reached the bank, so the wire module raises this as a typed
 * PROVIDER_ERROR rather than a verification verdict.
 */
export const SAMPLE_INVALID_INPUT_XML = `<AVSRealtimeQuery>
<MethodParameters>
<AVSRealtimeQueryResponse>
<AcceptsCredits isNull="true" />
<AcceptsDebits isNull="true" />
<AccountActive isNull="true" />
<AccountDormant isNull="true" />
<BankAccountNumberValid isNull="true" />
<EmailMatch isNull="true" />
<FileToken isNull="true" />
<IdNumberMatch isNull="true" />
<InitialMatch isNull="true" />
<LastNameMatch isNull="true" />
<Messages attr0="StringArray" isNull="false">
<StringArray0>Account Number Invalid</StringArray0>
<StringArray1>CDV Failure</StringArray1>
</Messages>
<OfflineRequest>False</OfflineRequest>
<PeriodActive isNull="true" />
<PhoneNumberMatch isNull="true" />
<TaxRefMatch isNull="true" />
<ErrorCode>203</ErrorCode>
</AVSRealtimeQueryResponse>
</MethodParameters>
</AVSRealtimeQuery>`

/**
 * A genuine failed verification: the enquiry SUCCEEDED (ErrorCode 000)
 * but the bank reported the required checks as Invalid.
 *
 * CONSTRUCTED, not verbatim — the doc publishes no failed-verification
 * sample (its only non-000 samples are 203 input-validation errors). This
 * is the verbatim 000 success sample with the three required checks
 * flipped to "Invalid", which is a documented AVSOptions.MatchIndicator
 * value; the doc's own 000 sample proves 000 responses can carry Invalid
 * fields (<InitialMatch>Invalid</InitialMatch>).
 */
export const SAMPLE_FAILURE_XML = SAMPLE_SUCCESS_XML.replace(
  "<AccountActive>Valid</AccountActive>",
  "<AccountActive>Invalid</AccountActive>"
)
  .replace("<AcceptsDebits>Valid</AcceptsDebits>", "<AcceptsDebits>Invalid</AcceptsDebits>")
  .replace("<IdNumberMatch>Valid</IdNumberMatch>", "<IdNumberMatch>Invalid</IdNumberMatch>")
