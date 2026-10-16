// @vitest-environment jsdom
// Two resets with different triggers (see the comments in UploadDialog.tsx):
//   - the form resets when the dialog opens or what it was opened with changes;
//   - the post-upload warning clears when `open` flips, and ONLY then, so a
//     parent re-render that hands in a fresh `allowedTypes` array while the
//     warning is on screen does not wipe it unread.
import type { ReactNode } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UploadDialog } from "./UploadDialog"

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    networkError: vi.fn(),
    document: { uploaded: vi.fn() },
  },
}))
vi.mock("./SelfieCapture", () => ({ SelfieCapture: () => null }))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <div data-select data-value={value} data-change={onValueChange}>{children}</div>
  ),
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const WARNING = "Application REF-1 is still waiting for its signed agreement."

let renderer: ReactTestRenderer
let fetchMock: ReturnType<typeof vi.fn>

type DialogProps = Partial<Parameters<typeof UploadDialog>[0]>

function element(props: DialogProps) {
  return (
    <UploadDialog open onOpenChange={vi.fn()} clientId="c1" onUploadComplete={vi.fn()} {...props} />
  )
}

async function mount(props: DialogProps) {
  await act(async () => { renderer = create(element(props)) })
}

async function rerender(props: DialogProps) {
  await act(async () => { renderer.update(element(props)) })
}

function selectedType(): string | null {
  const select = renderer.root.findAll((n) => n.props["data-select"] === true)[0]
  return select ? (select.props["data-value"] as string) : null
}

function pickType(value: string) {
  const select = renderer.root.findAll((n) => n.props["data-select"] === true)[0]
  act(() => { (select.props["data-change"] as (v: string) => void)(value) })
}

function textOf(node: unknown): string {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (node && typeof node === "object" && "props" in (node as { props?: unknown })) {
    return textOf((node as { props?: { children?: unknown } }).props?.children)
  }
  return ""
}

function pageText(): string {
  return JSON.stringify(renderer.toJSON())
}

async function uploadFileWithWarning() {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ signedAgreementWarning: { message: WARNING } }) })
  pickType("OTHER")
  const input = renderer.root.findAllByType("input").find((i) => i.props.type === "file")!
  const file = new File(["x"], "a.pdf", { type: "application/pdf" })
  await act(async () => { input.props.onChange({ target: { files: [file] } }) })
  const upload = renderer.root.findAllByType("button").find((b) => textOf(b.props.children) === "Upload")!
  await act(async () => { await upload.props.onClick() })
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  act(() => renderer.unmount())
  vi.unstubAllGlobals()
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
})

describe("UploadDialog form reset", () => {
  it("starts on the type it was opened with", async () => {
    await mount({ initialDocType: "ID_COPY" })
    expect(selectedType()).toBe("ID_COPY")
  })

  it("forgets a changed type when closed and reopened", async () => {
    await mount({ initialDocType: "ID_COPY" })
    pickType("OTHER")
    expect(selectedType()).toBe("OTHER")

    await rerender({ initialDocType: "ID_COPY", open: false })
    await rerender({ initialDocType: "ID_COPY", open: true })
    expect(selectedType()).toBe("ID_COPY")
  })

  it("follows a different initialDocType while open", async () => {
    await mount({ initialDocType: "ID_COPY" })
    await rerender({ initialDocType: "PROOF_OF_ADDRESS" })
    expect(selectedType()).toBe("PROOF_OF_ADDRESS")
  })
})

describe("UploadDialog post-upload warning", () => {
  it("stays on screen when the parent re-renders with a fresh allowedTypes array", async () => {
    await mount({ allowedTypes: ["ID_COPY", "OTHER"] })
    await uploadFileWithWarning()
    expect(pageText()).toContain(WARNING)

    await rerender({ allowedTypes: ["ID_COPY", "OTHER"] })
    expect(pageText()).toContain(WARNING)
  })

  it("is gone when the dialog is closed and reopened without 'I understand'", async () => {
    await mount({ allowedTypes: ["ID_COPY", "OTHER"] })
    await uploadFileWithWarning()
    expect(pageText()).toContain(WARNING)

    await rerender({ allowedTypes: ["ID_COPY", "OTHER"], open: false })
    await rerender({ allowedTypes: ["ID_COPY", "OTHER"], open: true })
    expect(pageText()).not.toContain(WARNING)
  })
})
