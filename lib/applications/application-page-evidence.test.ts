import { describe, expect, it } from "vitest"
import { applicationPageEvidence } from "./application-page-evidence"

const page = (over: Partial<Parameters<typeof applicationPageEvidence>[0]> = {}) =>
  applicationPageEvidence({ status: "UNDER_REVIEW", disclosureRegime: "NCA_PASQ", creditLifeDisclosureOk: true, bureauAction: "retry", ...over })

describe("the staff application page, NCA_PASQ (and no regime recorded: fail closed): as before", () => {
  it.each(["NCA_PASQ", null, undefined])("regime %s: blocks on a missing election under review, and only then", (disclosureRegime) => {
    expect(page({ disclosureRegime, creditLifeDisclosureOk: false }).creditLifeElectionMissing).toBe(true)
    expect(page({ disclosureRegime, creditLifeDisclosureOk: true }).creditLifeElectionMissing).toBe(false)
    expect(page({ disclosureRegime, creditLifeDisclosureOk: false, status: "SUBMITTED" }).creditLifeElectionMissing).toBe(false)
  })

  it.each(["NCA_PASQ", null, undefined])("regime %s: a draft with no election cannot be submitted, whatever else", (disclosureRegime) => {
    expect(page({ disclosureRegime, status: "DRAFT", creditLifeDisclosureOk: false }).creditLifeBlocksSubmit).toBe(true)
    expect(page({ disclosureRegime, status: "DRAFT", creditLifeDisclosureOk: true }).creditLifeBlocksSubmit).toBe(false)
    expect(page({ disclosureRegime, status: "UNDER_REVIEW", creditLifeDisclosureOk: false }).creditLifeBlocksSubmit).toBe(false)
  })

  it("asks for the NCA checks", () => {
    expect(page().ncaChecks).toBe(true)
  })

  it("offers the bureau retry or rerun by the rail action", () => {
    expect(page({ bureauAction: "retry" })).toMatchObject({ bureauRetry: true, bureauRerun: false })
    expect(page({ bureauAction: "rerun" })).toMatchObject({ bureauRetry: false, bureauRerun: true })
    expect(page({ bureauAction: "rerun", status: "APPROVED" }).bureauRerun).toBe(false)
  })

  it.each(["UNDER_REVIEW", "APPROVED", "DECLINED", "DISBURSED"])("shows the bureau panel on %s", (status) => {
    expect(page({ status }).bureauPanel).toBe(true)
  })

  it.each(["DRAFT", "SUBMITTED", "CANCELLED"])("shows no bureau panel on %s", (status) => {
    expect(page({ status }).bureauPanel).toBe(false)
  })
})

describe("the staff application page, KEY_FACTS: none of the South African evidence is asked for", () => {
  it.each(["DRAFT", "UNDER_REVIEW", "APPROVED", "DISBURSED"])("on %s it shows no election blocker, NCA checks, bureau button or panel", (status) => {
    for (const bureauAction of ["retry", "rerun"] as const) {
      expect(page({ disclosureRegime: "KEY_FACTS", status, creditLifeDisclosureOk: false, bureauAction })).toEqual({
        creditLifeElectionMissing: false, creditLifeBlocksSubmit: false, ncaChecks: false, bureauRetry: false, bureauRerun: false, bureauPanel: false,
      })
    }
  })
})
