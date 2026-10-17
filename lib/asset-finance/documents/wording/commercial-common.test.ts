import { expect, it } from "vitest"
import { referenceDefinition } from "./commercial-common"

it("the ZARONIA clause follows every published change without a minimum-move threshold", () => {
  expect(referenceDefinition("ZARONIA")).toContain("each published change")
  expect(referenceDefinition("ZARONIA")).not.toContain("0.25")
})
