import { describe, expect, it, vi } from "vitest"
import fixture from "./__fixtures__/sarb-home-page-rates.json"
import { fetchSarbObservations, parseSarbFeed, percentToDecimalFraction, SARB_FEED_URL } from "./sarb-rate-feed"

// The fixture is the public HomePageRates response, 2026-10-16 (CPI, PPI, bond
// yields and exchange rates alongside the three series this module reads).

const row = (code: string, value: unknown, date: unknown = "2026-10-16") => ({ Name: code, TimeseriesCode: code, Date: date, Value: value })
const feed = (over: Partial<Record<"MMRD002A" | "MMRD000A" | "MMRD855A", unknown>> = {}) => [
  row("MMRD002A", "MMRD002A" in over ? over.MMRD002A : 7.25),
  row("MMRD000A", "MMRD000A" in over ? over.MMRD000A : 10.75),
  row("MMRD855A", "MMRD855A" in over ? over.MMRD855A : 7.097, "2026-10-15"),
]
const bad = (body: unknown) => {
  const result = parseSarbFeed(body)
  if (result.ok) throw new Error("expected the feed to be refused")
  return result
}

describe("percentToDecimalFraction", () => {
  it.each([
    [7.097, "0.07097"],
    [10.75, "0.1075"],
    [7.25, "0.0725"],
    [11, "0.11"],
    [0.0001, "0.000001"],
    [49.9999, "0.499999"],
    [11.3, "0.113"],
    [8.29, "0.0829"],
  ])("%s percent is exactly %s", (percent, fraction) => {
    expect(percentToDecimalFraction(percent)?.toString()).toBe(fraction)
  })

  it("is not subject to float error (8.29 / 100 is 0.08289999999999999 as a float)", () => {
    expect(8.29 / 100).toBe(0.08289999999999999)
    expect(percentToDecimalFraction(8.29)?.toString()).toBe("0.0829")
    expect(percentToDecimalFraction(10.55)?.toString()).toBe("0.1055")
    expect(percentToDecimalFraction(6.85)?.toString()).toBe("0.0685")
  })

  it.each([0, -1, 50, 50.5, Number.NaN, Number.POSITIVE_INFINITY, 7.12345, "7.25", null, undefined, {}])("refuses %s", (value) => {
    expect(percentToDecimalFraction(value)).toBeNull()
  })
})

describe("parseSarbFeed", () => {
  it("reads repo, prime and ZARONIA from the real response, ignoring the other series", () => {
    const result = parseSarbFeed(fixture)
    if (!result.ok) throw new Error(result.detail)
    expect(result.observations.map((o) => [o.basis, o.timeseriesCode, o.effectiveDate, o.rate.toString()])).toEqual([
      ["REPO", "MMRD002A", "2026-10-16", "0.0725"],
      ["PRIME", "MMRD000A", "2026-10-16", "0.1075"],
      ["ZARONIA", "MMRD855A", "2026-10-15", "0.07097"],
    ])
  })

  it("is not thrown by a malformed row of a series it does not read", () => {
    expect(parseSarbFeed([...feed(), { TimeseriesCode: "CPI1000F", Value: "n/a", Date: null }, null, 7]).ok).toBe(true)
  })

  it.each([
    ["an object", {}, "bad_shape"],
    ["null", null, "bad_shape"],
    ["a string", "[]", "bad_shape"],
    ["an empty array", [], "missing_series"],
  ])("refuses %s as the body", (_label, body, reason) => {
    expect(bad(body).reason).toBe(reason)
  })

  it("refuses a feed that lacks a series, naming it", () => {
    const result = bad(feed().filter((r) => r.TimeseriesCode !== "MMRD000A"))
    expect(result).toMatchObject({ reason: "missing_series" })
    expect(result.detail).toContain("MMRD000A")
  })

  it("refuses a series that appears twice", () => {
    expect(bad([...feed(), row("MMRD002A", 7.5)]).reason).toBe("duplicate_series")
  })

  it.each([
    ["2026-13-01"],
    ["2026-02-30"],
    ["16/10/2026"],
    ["2026-10-16T00:00:00"],
    [20261016],
    [null],
  ])("refuses the date %s", (date) => {
    expect(bad([row("MMRD002A", 7.25, date), row("MMRD000A", 10.75), row("MMRD855A", 7.097)]).reason).toBe("bad_date")
  })

  it.each([[0], [-7.25], [50], [725], ["7.25"], [null], [7.12345]])("refuses the value %s", (value) => {
    expect(bad(feed({ MMRD855A: value })).reason).toBe("bad_value")
  })
})

describe("fetchSarbObservations", () => {
  const respond = (body: BodyInit | null, init?: ResponseInit) => vi.fn(async () => new Response(body, init)) as unknown as typeof fetch

  it("requests the feed with a timeout signal and parses the answer", async () => {
    const fetchImpl = respond(JSON.stringify(fixture))
    const result = await fetchSarbObservations(fetchImpl)
    expect(result.ok).toBe(true)
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]
    expect(url).toBe(SARB_FEED_URL)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("a non-2xx answer is http_status, with no retry", async () => {
    const fetchImpl = respond("Service Unavailable", { status: 503 })
    expect(await fetchSarbObservations(fetchImpl)).toMatchObject({ ok: false, reason: "http_status", detail: expect.stringContaining("503") })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("a body that is not JSON is not_json", async () => {
    expect(await fetchSarbObservations(respond("<html>maintenance</html>"))).toMatchObject({ ok: false, reason: "not_json" })
  })

  it("a refused connection is network", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed") }) as unknown as typeof fetch
    expect(await fetchSarbObservations(fetchImpl)).toMatchObject({ ok: false, reason: "network", detail: "fetch failed" })
  })

  it("a timeout is timeout, whether it strikes the request or the body", async () => {
    const timeout = () => Object.assign(new Error("signal timed out"), { name: "TimeoutError" })
    const onRequest = vi.fn(async () => { throw timeout() }) as unknown as typeof fetch
    expect(await fetchSarbObservations(onRequest)).toMatchObject({ ok: false, reason: "timeout" })
    const onBody = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw timeout() } })) as unknown as typeof fetch
    expect(await fetchSarbObservations(onBody)).toMatchObject({ ok: false, reason: "timeout" })
  })

  it("a reshaped body is the parser's typed error", async () => {
    expect(await fetchSarbObservations(respond(JSON.stringify({ rates: [] })))).toMatchObject({ ok: false, reason: "bad_shape" })
  })
})
