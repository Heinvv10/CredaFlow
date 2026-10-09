import { describe, it, expect } from "vitest"
import { getSigner } from "./index"
import { nativeSigner } from "./native"
import { signumSigner } from "./signum"

describe("getSigner", () => {
  it("NONE: getStatus resolves { state: 'none' }, requestSignature rejects", async () => {
    const signer = getSigner("NONE")
    await expect(signer.getStatus("t1", "x")).resolves.toEqual({ state: "none" })
    await expect(
      signer.requestSignature("t1", "doc1", [{ name: "Thabo M" }]),
    ).rejects.toThrow(/signing not enabled/i)
  })

  it("NATIVE: returns the native signer", () => {
    expect(getSigner("NATIVE")).toBe(nativeSigner)
  })

  it("SIGNUM: returns the signum signer", () => {
    expect(getSigner("SIGNUM")).toBe(signumSigner)
  })

  it("SIGNUM: requestSignature rejects with the flag-off message when DOCUMENT_SIGNUM_ENABLED is unset", async () => {
    delete process.env.DOCUMENT_SIGNUM_ENABLED
    await expect(
      signumSigner.requestSignature("t1", "doc1", [{ name: "Thabo M" }]),
    ).rejects.toThrow(/DOCUMENT_SIGNUM_ENABLED/)
  })
})
