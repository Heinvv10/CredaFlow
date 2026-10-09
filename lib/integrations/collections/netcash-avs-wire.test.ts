// lib/integrations/collections/netcash-avs-wire.test.ts
import { describe, it, expect, vi, afterEach } from "vitest"
import { buildAvsRequestBody, parseAvsResponse, netcashAvsQuery } from "./netcash-avs-wire"
import {
  SAMPLE_SUCCESS_XML,
  SAMPLE_FAILURE_XML,
  SAMPLE_INVALID_INPUT_XML,
} from "./__fixtures__/netcash-avs-response"
import type { AvsRequest } from "./types"

function catchSync(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error("expected the call to throw, but it returned")
}

const req: AvsRequest = {
  accountHolder: "T Client",
  idNumber: "9001015800086",
  bankName: "FNB",
  branchCode: "250655",
  accountNumber: "62000000000",
  accountType: "CHEQUE",
}

describe("buildAvsRequestBody", () => {
  it("embeds the service key and all account fields", () => {
    const body = buildAvsRequestBody(req, "SERVICE-KEY-GUID")
    expect(body).toContain("SERVICE-KEY-GUID")
    expect(body).toContain("62000000000")
    expect(body).toContain("250655")
    expect(body).toContain("9001015800086")
  })

  it("escapes XML-special characters in the account holder", () => {
    const body = buildAvsRequestBody(
      {
        accountHolder: "T & Co <Client>",
        idNumber: "9001015800086",
        bankName: "FNB",
        branchCode: "250655",
        accountNumber: "62000000000",
        accountType: "SAVINGS",
      },
      "K"
    )
    expect(body).toContain("T &amp; Co &lt;Client&gt;")
  })

  it("maps our provider-agnostic accountType onto the Netcash BankAccountType enum", () => {
    const cheque = buildAvsRequestBody(req, "K")
    expect(cheque).toContain("<BankAccountType>Current</BankAccountType>")

    const savings = buildAvsRequestBody({ ...req, accountType: "SAVINGS" }, "K")
    expect(savings).toContain("<BankAccountType>Savings</BankAccountType>")

    // Transmission remains a real WSDL member but has no source value: it was
    // retired as a selectable Client.accountType on 2026-08-05, so nothing can
    // produce it. AvsRequest["accountType"] no longer admits it — the compiler
    // is the guard here, and these two are the only bodies that can be built.
  })

  it("targets the documented NIWS_NIF endpoint's AVSRealtimeQuery envelope", () => {
    const body = buildAvsRequestBody(req, "K")
    expect(body).toContain("<AVSRealtimeQuery")
    expect(body).toContain('xmlns="http://tempuri.org/"')
  })
})

describe("parseAvsResponse", () => {
  it("maps a success response to passed=true with all three required checks true", () => {
    const result = parseAvsResponse(SAMPLE_SUCCESS_XML)
    expect(result.passed).toBe(true)
    expect(result.checks.accountActive).toBe(true)
    expect(result.checks.acceptsDebits).toBe(true)
    expect(result.checks.idNumberMatch).toBe(true)
    expect(result.checks.lastNameMatch).toBe(true)
    expect(result.checks.openThreeMonths).toBe(true)
    expect(result.raw).toBe(SAMPLE_SUCCESS_XML)
  })

  it("maps a failed verification (ErrorCode 000, required checks Invalid) to passed=false, preserving raw", () => {
    const result = parseAvsResponse(SAMPLE_FAILURE_XML)
    expect(result.passed).toBe(false)
    expect(result.checks.accountActive).toBe(false)
    expect(result.checks.acceptsDebits).toBe(false)
    expect(result.checks.idNumberMatch).toBe(false)
    expect(result.raw).toBeTruthy()
  })

  it("maps a tag that is entirely absent to null without failing an advisory check", () => {
    const withoutLastName = SAMPLE_SUCCESS_XML.replace("<LastNameMatch>Valid</LastNameMatch>\n", "")
    const result = parseAvsResponse(withoutLastName)
    expect(result.checks.lastNameMatch).toBeNull()
    expect(result.passed).toBe(true)
  })

  it("fails closed when a required check reports NotApplicable", () => {
    const notApplicableAccountActive = SAMPLE_SUCCESS_XML.replace(
      "<AccountActive>Valid</AccountActive>",
      "<AccountActive>NotApplicable</AccountActive>"
    )
    const result = parseAvsResponse(notApplicableAccountActive)
    expect(result.checks.accountActive).toBeNull()
    expect(result.passed).toBe(false)
  })

  it("treats Invalid as a hard false on a required check", () => {
    const invalidIdMatch = SAMPLE_SUCCESS_XML.replace(
      "<IdNumberMatch>Valid</IdNumberMatch>",
      "<IdNumberMatch>Invalid</IdNumberMatch>"
    )
    const result = parseAvsResponse(invalidIdMatch)
    expect(result.checks.idNumberMatch).toBe(false)
    expect(result.passed).toBe(false)
  })
})

describe("parseAvsResponse vendor error codes", () => {
  it("throws PROVIDER_ERROR on ErrorCode 203 (input never reached the bank), surfacing the Messages text", () => {
    const err = catchSync(() => parseAvsResponse(SAMPLE_INVALID_INPUT_XML))
    expect(err).toMatchObject({ name: "CollectionProviderError", code: "PROVIDER_ERROR" })
    expect((err as Error).message).toContain("203")
    expect((err as Error).message).toContain("Account Number Invalid")
  })

  it("throws PROVIDER_ERROR on ErrorCode 100 (authentication failed)", () => {
    const authFailure = SAMPLE_INVALID_INPUT_XML.replace("<ErrorCode>203</ErrorCode>", "<ErrorCode>100</ErrorCode>")
    const err = catchSync(() => parseAvsResponse(authFailure))
    expect(err).toMatchObject({ name: "CollectionProviderError", code: "PROVIDER_ERROR" })
    expect((err as Error).message).toContain("100")
    expect((err as Error).message).toContain("Authentication failed")
  })

  it("throws PROVIDER_ERROR on ErrorCode 200 (general service error)", () => {
    const serviceError = SAMPLE_INVALID_INPUT_XML.replace("<ErrorCode>203</ErrorCode>", "<ErrorCode>200</ErrorCode>")
    const err = catchSync(() => parseAvsResponse(serviceError))
    expect(err).toMatchObject({ name: "CollectionProviderError", code: "PROVIDER_ERROR" })
    expect((err as Error).message).toContain("200")
  })

  it("throws PROVIDER_ERROR when the response carries no ErrorCode at all (off-contract)", () => {
    const noErrorCode = SAMPLE_SUCCESS_XML.replace("<ErrorCode>000</ErrorCode>\n", "")
    const err = catchSync(() => parseAvsResponse(noErrorCode))
    expect(err).toMatchObject({ name: "CollectionProviderError", code: "PROVIDER_ERROR" })
  })
})

describe("netcashAvsQuery", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("POSTs to the documented NIWS_NIF endpoint with the SOAPAction from the live WSDL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(SAMPLE_SUCCESS_XML),
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await netcashAvsQuery(req, "SERVICE-KEY-GUID")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://ws.netcash.co.za/NIWS/NIWS_NIF.svc")
    expect(init.method).toBe("POST")
    expect(init.headers["Content-Type"]).toBe("text/xml; charset=utf-8")
    expect(init.headers.SOAPAction).toBe('"http://tempuri.org/INIWS_NIF/AVSRealtimeQuery"')
    expect(result.passed).toBe(true)
  })

  it("throws a typed PROVIDER_ERROR on a non-2xx HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      })
    )

    await expect(netcashAvsQuery(req, "K")).rejects.toMatchObject({
      name: "CollectionProviderError",
      code: "PROVIDER_ERROR",
    })
  })

  it("wraps network-level fetch failures (DNS/refused/timeout) in a typed PROVIDER_ERROR", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")))

    let caught: unknown
    try {
      await netcashAvsQuery(req, "K")
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ name: "CollectionProviderError", code: "PROVIDER_ERROR" })
    expect((caught as Error).message).toContain("Netcash AVS request failed")
    expect((caught as Error).message).toContain("fetch failed")
  })

  it("wraps a body-read failure in a typed PROVIDER_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error("aborted mid-body")),
      })
    )

    await expect(netcashAvsQuery(req, "K")).rejects.toMatchObject({
      name: "CollectionProviderError",
      code: "PROVIDER_ERROR",
    })
  })

  it("propagates a vendor ErrorCode PROVIDER_ERROR from the body without re-wrapping it as a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(SAMPLE_INVALID_INPUT_XML),
      })
    )

    let caught: unknown
    try {
      await netcashAvsQuery(req, "K")
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ name: "CollectionProviderError", code: "PROVIDER_ERROR" })
    expect((caught as Error).message).toContain("203")
    expect((caught as Error).message).not.toContain("request failed")
  })
})
