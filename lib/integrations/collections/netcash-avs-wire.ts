// lib/integrations/collections/netcash-avs-wire.ts
/**
 * Netcash AVS-R (ID / Bank Account Verification, Real-Time) live wire
 * client. SOAP 1.1, document/literal wrapped, on the NIWS_NIF entry
 * point. Netcash-specific naming stays inside this file — see
 * __fixtures__/netcash-avs-response.ts for the full transcription record
 * (doc URLs, WSDL citation, and every deviation from the task brief).
 */
import { CollectionProviderError, type AvsChecks, type AvsRequest, type AvsResult } from "./types"

/** https://api.netcash.co.za/ws-methods/ — NIF entry point. */
const NIWS_AVS_ENDPOINT = "https://ws.netcash.co.za/NIWS/NIWS_NIF.svc"

/**
 * Not published on either doc page — read from the live WSDL
 * (https://ws.netcash.co.za/NIWS/NIWS_NIF.svc?singleWsdl), operation
 * AVSRealtimeQuery, wsdl:binding soap:operation soapAction.
 */
const NIWS_AVS_SOAP_ACTION = "http://tempuri.org/INIWS_NIF/AVSRealtimeQuery"

/**
 * WSDL enum MandateOptions.BankAccountType: "Current" | "Savings" |
 * "Transmission". Only the first two have a source value: TRANSMISSION was
 * not a selectable Client.accountType (it was never
 * chosen by any client, and the database guards never accepted it).
 */
const ACCOUNT_TYPE_MAP: Record<AvsRequest["accountType"], string> = {
  CHEQUE: "Current",
  SAVINGS: "Savings",
}

// Copied from lib/integrations/netcash.ts:52-59 (legacy payout client) —
// kept local per Task 4 instructions rather than importing across modules.
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/**
 * Builds the SOAP 1.1 request body for AVSRealtimeQuery. Element order
 * matches the live WSDL's <xsd:element name="AVSRealtimeQuery"> sequence
 * exactly (ServiceKey ... Email) — this is NOT the order the doc page's
 * "Mandatory fields" table lists them in.
 *
 * AccountReference is a Netcash-mandatory field with no source in
 * AvsRequest; we fill it with the ID number (already part of the payload,
 * so this adds no new PII exposure) as a documented judgment call, not a
 * transcription.
 */
export function buildAvsRequestBody(req: AvsRequest, serviceKey: string): string {
  const accountReference = escapeXml(req.idNumber)
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
    "  <soap:Body>",
    '    <AVSRealtimeQuery xmlns="http://tempuri.org/">',
    `      <ServiceKey>${escapeXml(serviceKey)}</ServiceKey>`,
    `      <AccountReference>${accountReference}</AccountReference>`,
    "      <Extra1 />",
    "      <Extra2 />",
    "      <Extra3 />",
    `      <BankAccountNumber>${escapeXml(req.accountNumber)}</BankAccountNumber>`,
    `      <BranchCode>${escapeXml(req.branchCode)}</BranchCode>`,
    `      <BankAccountType>${ACCOUNT_TYPE_MAP[req.accountType]}</BankAccountType>`,
    `      <EnquiryName>${escapeXml(req.accountHolder)}</EnquiryName>`,
    "      <Initials />",
    `      <IdNumber>${escapeXml(req.idNumber)}</IdNumber>`,
    "      <IsIdNumber>true</IsIdNumber>",
    "      <PhoneNumber />",
    "      <Email />",
    "    </AVSRealtimeQuery>",
    "  </soap:Body>",
    "</soap:Envelope>",
  ].join("\n")
}

/**
 * Extracts a response element's text content by local name, tolerating an
 * optional namespace prefix (`<a:AccountActive>` vs `<AccountActive>`).
 * Only an open/close pair with non-empty content yields a value; a
 * self-closing element (the shape the doc's samples use for absent
 * fields, e.g. `<AccountActive isNull="true" />`), an empty pair, or a
 * missing element all return null because the regex requires the pair —
 * attributes are never inspected.
 */
function extractField(xml: string, tag: string): string | null {
  const openClose = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`)
  const match = xml.match(openClose)
  if (match) return match[1].length > 0 ? match[1] : null
  return null
}

/**
 * Collects the <Messages/> StringArrayN item texts (the doc's 203 samples
 * carry the error description there, e.g. "Account Number Invalid").
 */
function extractMessages(xml: string): string {
  const items: string[] = []
  const re = /<(?:\w+:)?StringArray\d+>([\s\S]*?)<\/(?:\w+:)?StringArray\d+>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) items.push(m[1])
  return items.join("; ")
}

/**
 * Doc's "Output" error-code table, verbatim
 * (https://api.netcash.co.za/value-added-services/avs-real-time/).
 * 000 is the only success code.
 */
const AVS_SUCCESS_CODE = "000"
const AVS_ERROR_DESCRIPTIONS: Record<string, string> = {
  "100": "Authentication failed",
  "200": "General service error. Contact support",
  "203": "SA ID number, Bank account number, Branch code or Bank account type invalid",
}

/** WSDL enum AVSOptions.MatchIndicator: "Valid" | "Invalid" | "NotApplicable". */
function toTriBool(raw: string | null): boolean | null {
  if (raw === "Valid") return true
  if (raw === "Invalid") return false
  // NotApplicable, isNull="true"/i:nil="true", or missing entirely.
  return null
}

/**
 * Parses an AVSRealtimeQuery(Response) body.
 *
 * ErrorCode gate first: only 000 ("Enquiry Successful") means the bank
 * was actually consulted. 100/200/203, an unlisted code, or a missing
 * ErrorCode element all mean the enquiry never completed — those throw a
 * typed PROVIDER_ERROR (carrying the code and the <Messages/> text)
 * instead of returning a business-shaped result, so a rotated service
 * key or a Netcash outage can never masquerade as a failed verification.
 *
 * Pass rule is spec-fixed (collection engine design §6), not
 * vendor-defined: the three required checks must each be exactly true;
 * surname/account-age are advisory and don't affect `passed`.
 */
export function parseAvsResponse(xml: string): AvsResult {
  const errorCode = extractField(xml, "ErrorCode")
  if (errorCode !== AVS_SUCCESS_CODE) {
    const description =
      errorCode === null
        ? "response carried no ErrorCode element (off-contract response)"
        : (AVS_ERROR_DESCRIPTIONS[errorCode] ?? "unrecognised code (not in the transcribed doc's table)")
    const messages = extractMessages(xml)
    throw new CollectionProviderError(
      "PROVIDER_ERROR",
      `Netcash AVS ErrorCode ${errorCode ?? "<missing>"}: ${description}${messages ? ` — ${messages}` : ""}`
    )
  }
  const checks: AvsChecks = {
    accountActive: toTriBool(extractField(xml, "AccountActive")),
    acceptsDebits: toTriBool(extractField(xml, "AcceptsDebits")),
    idNumberMatch: toTriBool(extractField(xml, "IdNumberMatch")),
    lastNameMatch: toTriBool(extractField(xml, "LastNameMatch")),
    // PeriodActive is the best-fit inference for "account open >= 3
    // months" — see __fixtures__/netcash-avs-response.ts for why.
    openThreeMonths: toTriBool(extractField(xml, "PeriodActive")),
  }
  const passed = checks.accountActive === true && checks.acceptsDebits === true && checks.idNumberMatch === true
  return { passed, checks, raw: xml }
}

export async function netcashAvsQuery(req: AvsRequest, serviceKey: string): Promise<AvsResult> {
  let res: Response
  let text: string
  try {
    res = await fetch(NIWS_AVS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `"${NIWS_AVS_SOAP_ACTION}"`,
      },
      body: buildAvsRequestBody(req, serviceKey),
    })
    text = await res.text()
  } catch (e) {
    // DNS/connection/timeout/body-read failures — surface typed, never raw.
    throw new CollectionProviderError(
      "PROVIDER_ERROR",
      `Netcash AVS request failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (!res.ok) {
    throw new CollectionProviderError("PROVIDER_ERROR", `Netcash AVS HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return parseAvsResponse(text)
}
