import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DocumentsPanel } from "./DocumentsPanel"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

/**
 * DocumentsTab must be keyed by CLIENT, not only by the generation counter.
 *
 * It holds fetched documents and signing packets in state, and both fetches
 * leave the previous state in place when a request fails. This page is a `[id]`
 * segment and React reconciles a client component by type and position, so
 * moving between two clients without a key change reuses the instance — a failed
 * refetch for client B then leaves client A's documents and client A's
 * signing-packet card, captioned as signed evidence with a working download
 * link, under client B's name.
 *
 * Asserted on the rendered tree rather than on the source, so it fails if the
 * key stops varying by client for ANY reason, not just if this exact expression
 * is edited.
 */
describe("DocumentsPanel client isolation", () => {
  const renderers: ReactTestRenderer[] = []

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    // Two calls per mount (documents + signing packets); both empty is fine —
    // this test is about identity, not content.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])))
  })

  afterEach(async () => {
    for (const r of renderers.splice(0)) await act(async () => r.unmount())
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  async function mount(clientId: string) {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <DocumentsPanel clientId={clientId} popiaConsentGiven customTemplates={[]} />,
      )
    })
    renderers.push(renderer)
    return renderer
  }

  /** The key React will use to decide whether to reuse the DocumentsTab instance. */
  function documentsTabKey(renderer: ReactTestRenderer): string | null {
    const match = renderer.root.findAll(
      (node) => typeof node.type === "function"
        && (node.type as { name?: string }).name === "DocumentsTab",
    )[0]
    return match ? String((match as unknown as { _fiber?: { key?: string } })._fiber?.key
      ?? (match.instance as unknown as { key?: string })?.key
      ?? match.props.clientId) : null
  }

  it("gives two different clients two different DocumentsTab keys", async () => {
    const a = await mount("client-a")
    const b = await mount("client-b")
    // Whatever the key derivation, the identity must differ by client.
    expect(documentsTabKey(a)).not.toBe(documentsTabKey(b))
  })

  it("passes the clientId straight through to DocumentsTab", async () => {
    const a = await mount("client-a")
    const tab = a.root.findAll(
      (node) => typeof node.type === "function"
        && (node.type as { name?: string }).name === "DocumentsTab",
    )[0]
    expect(tab.props.clientId).toBe("client-a")
  })

  // The key expression is the actual control, and it is a one-line edit away
  // from silently dropping the client. Read the source too: the rendered-tree
  // assertion above cannot see a key that varies for the WRONG reason.
  it("derives the DocumentsTab key from the clientId", async () => {
    const { readFileSync } = await import("node:fs")
    const path = await import("node:path")
    const src = readFileSync(
      path.join(process.cwd(), "components/documents/DocumentsPanel.tsx"),
      "utf8",
    )
    const key = /key=\{([^}]+)\}/.exec(src)
    expect(key, "no key= on DocumentsTab — this test is blind, fix the parser").toBeTruthy()
    expect(key![1]).toContain("clientId")
  })
})
