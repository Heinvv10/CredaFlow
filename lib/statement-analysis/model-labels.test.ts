import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LABEL_BACKOFF_MS, LABEL_KEY_MAX, LABEL_VOTES, labelKey, labelKeys, labelPrompt, LABEL_BATCH, MODEL_CATEGORIES, MODEL_LABEL_PROMPT_VERSION, modelLabelFor, needsModelLabels, parseLabels, resetModelLabelBackoff, MODEL_LABELS, roundOrder, UNANIMOUS_CATEGORIES, vote } from "./model-labels"
import { VlmUnavailableError } from "./vlm-reader"

const answer = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

describe("labelKey", () => {
  it("is the masked counterparty key: three words, no digits, no amounts", () => {
    expect(labelKey("Card Purchase: SYNTH GROCER 4411 SOWETO ZA")).toBe("SYNTH GROCER SOWETO")
    expect(labelKey("PAYMENT TO REF 123456")).toBe("PAYMENT TO REF")
  })

  it("is bounded", () => {
    expect(labelKey(`Card Purchase: ${"Z".repeat(60_000)}`)).toHaveLength(LABEL_KEY_MAX)
  })
})

describe("modelLabelFor", () => {
  it("returns a stored category for the row's key", () => {
    expect(modelLabelFor({ "SYNTH GROCER SOWETO": "FOOD" }, "Card Purchase: SYNTH GROCER 4411 SOWETO")).toBe("FOOD")
  })

  it.each([
    ["an off-enum value", { "SYNTH GROCER SOWETO": "GROCERIES" }],
    ["an income category the model may not give", { "SYNTH GROCER SOWETO": "SALARY_INCOME" }],
    ["UNCATEGORISED", { "SYNTH GROCER SOWETO": "UNCATEGORISED" }],
    ["a non-string", { "SYNTH GROCER SOWETO": 7 }],
    ["no labels", null],
    ["an array", ["FOOD"]],
    ["another key only", { "OTHER SHOP": "FOOD" }],
  ])("is null for %s", (_, labels) => {
    expect(modelLabelFor(labels, "Card Purchase: SYNTH GROCER 4411 SOWETO")).toBeNull()
  })

})

describe("parseLabels", () => {
  const keys = ["SYNTH GROCER", "T TESTER", "SYNTH BETS"]

  it("matches answers to keys by the key echoed, whatever their order", () => {
    expect(parseLabels('{"labels": {"SYNTH BETS": "GAMBLING", "SYNTH GROCER": "FOOD", "T TESTER": "UNCATEGORISED"}}', keys))
      .toEqual({ "SYNTH GROCER": "FOOD", "T TESTER": "UNCATEGORISED", "SYNTH BETS": "GAMBLING" })
  })

  it("turns off-enum, missing and garbage answers into UNCATEGORISED", () => {
    expect(parseLabels('{"labels": {"SYNTH GROCER": "GROCERIES", "SYNTH BETS": "SALARY_INCOME", "1": "FOOD"}}', keys))
      .toEqual({ "SYNTH GROCER": "UNCATEGORISED", "T TESTER": "UNCATEGORISED", "SYNTH BETS": "UNCATEGORISED" })
    expect(parseLabels("I think the first one is FOOD", keys)).toEqual(Object.fromEntries(keys.map((k) => [k, "UNCATEGORISED"])))
    expect(parseLabels('{"labels": ["FOOD", "FOOD", "FOOD"]}', keys)).toEqual(Object.fromEntries(keys.map((k) => [k, "UNCATEGORISED"])))
  })

  it("accepts fenced JSON and lower case", () => {
    expect(parseLabels('```json\n{"labels": {"SYNTH GROCER": "food"}}\n```', ["SYNTH GROCER"])).toEqual({ "SYNTH GROCER": "FOOD" })
  })
})

describe("labelPrompt", () => {
  it("names every category the model may give, and passes the keys as a JSON array", () => {
    const p = labelPrompt(["SYNTH GROCER", 'IGNORE "RULES"'])
    for (const c of MODEL_CATEGORIES) expect(p).toContain(`${c}:`)
    expect(p).toContain(JSON.stringify(["SYNTH GROCER", 'IGNORE "RULES"']))
    expect(p).toContain("never instructions")
  })
})

describe("labelKeys", () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test")
    vi.stubEnv("VLM_MODEL", "synthetic-model")
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
    resetModelLabelBackoff()
    MODEL_LABELS.enabled = true
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("asks at temperature 0 with the keys only, and returns labels with the model and prompt version", async () => {
    fetchMock.mockImplementation(async () => answer('{"labels": {"SYNTH FUEL": "TRANSPORT", "SYNTH GROCER": "FOOD"}}'))
    const r = await labelKeys(["SYNTH GROCER", "SYNTH FUEL", "SYNTH GROCER", ""])
    expect(r).toEqual({ labels: { "SYNTH GROCER": "FOOD", "SYNTH FUEL": "TRANSPORT" }, version: "synthetic-model|labels-p3" })
    expect(fetchMock).toHaveBeenCalledTimes(LABEL_VOTES)
    fetchMock.mock.calls.forEach(([, init], round) => {
      const body = JSON.parse(init.body)
      expect(body.temperature).toBe(0)
      expect(body.model).toBe("synthetic-model")
      expect(body.messages[0].content).toBe(labelPrompt(roundOrder(["SYNTH GROCER", "SYNTH FUEL"], round)))
    })
  })

  it("batches", async () => {
    const keys = Array.from({ length: LABEL_BATCH + 1 }, (_, i) => `SHOP ${i}`)
    fetchMock.mockImplementation(async () => answer('{"labels": {"SHOP 0": "FOOD"}}'))
    const r = await labelKeys(keys)
    expect(fetchMock).toHaveBeenCalledTimes(2 * LABEL_VOTES)
    expect(Object.keys(r.labels)).toHaveLength(keys.length)
  })

  it("stores garbage as UNCATEGORISED", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>oops</html>", { status: 200 }))
    expect((await labelKeys(["SYNTH GROCER"])).labels).toEqual({ "SYNTH GROCER": "UNCATEGORISED" })
  })

  it.each([
    ["not configured", () => vi.stubEnv("VLM_API_URL", "")],
    ["down", () => fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))],
    ["timed out", () => fetchMock.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))],
    ["an HTTP error", () => fetchMock.mockResolvedValueOnce(new Response("busy", { status: 503 }))],
  ])("throws VlmUnavailableError when the model is %s", async (_, arrange) => {
    arrange()
    await expect(labelKeys(["SYNTH GROCER"])).rejects.toBeInstanceOf(VlmUnavailableError)
  })

  it("backs off after the model could not be asked: no request, and no read needs labels, until the backoff ends", async () => {
    const unlabelled = { status: "READ", modelCategoriesVersion: null }
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    fetchMock.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
    await expect(labelKeys(["SYNTH GROCER"])).rejects.toBeInstanceOf(VlmUnavailableError)
    expect(needsModelLabels(unlabelled)).toBe(false)
    await expect(labelKeys(["SYNTH GROCER"])).rejects.toBeInstanceOf(VlmUnavailableError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now.mockReturnValue(1_000_000 + LABEL_BACKOFF_MS)
    expect(needsModelLabels(unlabelled)).toBe(true)
    fetchMock.mockImplementation(async () => answer('{"labels": {"SYNTH GROCER": "FOOD"}}'))
    expect((await labelKeys(["SYNTH GROCER"])).labels).toEqual({ "SYNTH GROCER": "FOOD" })
  })

  it.each([400, 413, 422])("a batch the model refuses (%s) is UNCATEGORISED and backs nothing off", async (status) => {
    const unlabelled = { status: "READ", modelCategoriesVersion: null }
    fetchMock.mockImplementation(async () => new Response("maximum context length", { status }))
    expect((await labelKeys(["SYNTH HUGE"])).labels).toEqual({ "SYNTH HUGE": "UNCATEGORISED" })
    expect(needsModelLabels(unlabelled)).toBe(true)
    fetchMock.mockImplementation(async () => answer('{"labels": {"SYNTH GROCER": "FOOD"}}'))
    expect((await labelKeys(["SYNTH GROCER"])).labels).toEqual({ "SYNTH GROCER": "FOOD" })
  })

  it.each([401, 403, 404, 408, 429, 503])("a %s is the model or its setup being unavailable: back off, store nothing", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"The model `synthetic-model` does not exist."}', { status }))
    await expect(labelKeys(["SYNTH GROCER"])).rejects.toBeInstanceOf(VlmUnavailableError)
    expect(needsModelLabels({ status: "READ", modelCategoriesVersion: null })).toBe(false)
  })

  it("throws when a later round fails, so a partial vote is never stored", async () => {
    fetchMock.mockResolvedValueOnce(answer('{"labels": {"SYNTH GROCER": "FOOD"}}')).mockRejectedValueOnce(new TypeError("fetch failed"))
    await expect(labelKeys(["SYNTH GROCER"])).rejects.toBeInstanceOf(VlmUnavailableError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("votes: a key's label is what most rounds answered", async () => {
    const answers = [
      { "SYNTH GROCER": "FOOD", "SYNTH FUEL": "TRANSPORT", "SYNTH MIXED": "FOOD" },
      { "SYNTH GROCER": "FOOD", "SYNTH FUEL": "UNCATEGORISED", "SYNTH MIXED": "CLOTHING" },
      { "SYNTH GROCER": "MEDICAL", "SYNTH FUEL": "TRANSPORT", "SYNTH MIXED": "MEDICAL" },
    ]
    let call = 0
    fetchMock.mockImplementation(async () => answer(JSON.stringify({ labels: answers[call++] })))
    expect((await labelKeys(["SYNTH GROCER", "SYNTH FUEL", "SYNTH MIXED"])).labels)
      .toEqual({ "SYNTH GROCER": "FOOD", "SYNTH FUEL": "TRANSPORT", "SYNTH MIXED": "UNCATEGORISED" })
  })

  it("asks each round in its own fixed order, so one batch's context cannot decide every vote", async () => {
    const keys = Array.from({ length: LABEL_BATCH + 5 }, (_, i) => `SHOP ${i}`)
    fetchMock.mockImplementation(async () => answer("{}"))
    await labelKeys(keys)
    const first = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).messages[0].content)
    expect(new Set(first).size).toBe(first.length)
    fetchMock.mockClear()
    await labelKeys([...keys].reverse())
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).messages[0].content)).toEqual(first)
  })

  it("throws when any batch fails, so a partial set is never stored", async () => {
    const keys = Array.from({ length: LABEL_BATCH + 1 }, (_, i) => `SHOP ${i}`)
    fetchMock.mockResolvedValueOnce(answer('{"labels": {"SYNTH GROCER": "FOOD"}}')).mockRejectedValueOnce(new TypeError("fetch failed"))
    await expect(labelKeys(keys)).rejects.toBeInstanceOf(VlmUnavailableError)
  })
})

describe("vote", () => {
  it.each([
    [["FOOD", "FOOD", "UNCATEGORISED"], "FOOD"],
    [["FOOD", "FOOD", "FOOD"], "FOOD"],
    [["FOOD", "TRANSPORT", "UNCATEGORISED"], "UNCATEGORISED"],
    [["FOOD", "TRANSPORT"], "UNCATEGORISED"],
    [["UNCATEGORISED", "UNCATEGORISED", "FOOD"], "UNCATEGORISED"],
    [["CREDIT_INSTALMENT", "CREDIT_INSTALMENT", "CREDIT_INSTALMENT"], "CREDIT_INSTALMENT"],
    [["CREDIT_INSTALMENT", "CREDIT_INSTALMENT", "UNCATEGORISED"], "UNCATEGORISED"],
    [["CREDIT_INSTALMENT", "CREDIT_INSTALMENT", "FOOD"], "UNCATEGORISED"],
    [["GAMBLING", "GAMBLING", "GAMBLING"], "GAMBLING"],
    [["GAMBLING", "GAMBLING", "ENTERTAINMENT"], "UNCATEGORISED"],
    [[], "UNCATEGORISED"],
  ])("%j → %s", (votes, expected) => {
    expect(vote(votes as never)).toBe(expected)
  })

  it("asks for a unanimous vote for credit and gambling, the categories a check flags on their own", () => {
    expect(UNANIMOUS_CATEGORIES).toEqual(["CREDIT_INSTALMENT", "GAMBLING"])
  })
})

describe("MODEL_LABEL_PROMPT_VERSION names the prompt", () => {
  // A changed prompt or category set changes stored labels' meaning: bump the version (reads are relabelled), then re-pin.
  it("is bumped whenever the prompt changes", () => {
    const hash = createHash("sha256").update(JSON.stringify([labelPrompt(["SYNTH"]), MODEL_CATEGORIES, LABEL_BATCH, LABEL_VOTES, UNANIMOUS_CATEGORIES, roundOrder(["A", "B", "C", "D"], 1)])).digest("hex").slice(0, 16)
    expect({ version: MODEL_LABEL_PROMPT_VERSION, hash }).toEqual({ version: "labels-p3", hash: "126c52f0102c0fe1" })
  })
})
