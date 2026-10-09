import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    documentTemplate: { findFirst: vi.fn() },
    documentTemplateVersion: { findFirst: vi.fn() },
    client: { findFirst: vi.fn() },
    loan: { findFirst: vi.fn() },
    loanApplication: { findFirst: vi.fn() },
    tenant: { findUnique: vi.fn() },
    user: { findFirst: vi.fn() },
    clientDocument: { create: vi.fn() },
    documentAccessLog: { create: vi.fn() },
  },
}))

vi.mock("@/lib/documents/catalogue", () => ({
  SYSTEM_GENERATORS: {
    creditAgreement: vi.fn(),
  },
}))

vi.mock("@/lib/documents/html-to-pdf", () => ({ htmlToPdf: vi.fn() }))
vi.mock("@/lib/storage", () => ({ saveFile: vi.fn() }))

import { prisma } from "@/lib/prisma"
import { SYSTEM_GENERATORS } from "@/lib/documents/catalogue"
import { htmlToPdf } from "@/lib/documents/html-to-pdf"
import { saveFile } from "@/lib/storage"
import { generateDocument, MissingTokenError, SystemGenerationNotAllowedError } from "./render"

beforeEach(() => vi.clearAllMocks())

const tenant = { id: "t1", name: "Acme Lending" }
const client = {
  id: "c1",
  firstName: "Thabo",
  lastName: "M",
  idNumber: "9001015800081",
}

const CUSTOM_TEMPLATE = {
  id: "tpl1",
  tenantId: "t1",
  key: "welcome-letter",
  name: "Welcome Letter",
  kind: "CUSTOM",
  systemGenerator: null,
  isActive: true,
  currentVersionId: "v1",
  deletedAt: null,
}

const SYSTEM_TEMPLATE = {
  id: "tpl_sys",
  tenantId: "t1",
  key: "credit-agreement",
  name: "Credit Agreement",
  kind: "SYSTEM",
  systemGenerator: "creditAgreement",
  currentVersionId: null,
  deletedAt: null,
}

function mockCommonLookups() {
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue(tenant as never)
  vi.mocked(prisma.client.findFirst).mockResolvedValue(client as never)
  vi.mocked(prisma.loan.findFirst).mockResolvedValue(null)
  vi.mocked(prisma.loanApplication.findFirst).mockResolvedValue(null)
  vi.mocked(prisma.user.findFirst).mockResolvedValue(null)
}

describe("generateDocument — CUSTOM, all tokens present", () => {
  it("renders bodyHtml, calls htmlToPdf, creates ClientDocument + DocumentAccessLog, returns the buffer", async () => {
    mockCommonLookups()
    vi.mocked(prisma.documentTemplate.findFirst).mockResolvedValue(CUSTOM_TEMPLATE as never)
    vi.mocked(prisma.documentTemplateVersion.findFirst).mockResolvedValue({
      id: "v1",
      templateId: "tpl1",
      version: 1,
      bodyHtml: "<p>Hello {{client.fullName}}</p>",
      status: "ACTIVE",
    } as never)
    const pdfBuffer = Buffer.from("%PDF-custom")
    vi.mocked(htmlToPdf).mockResolvedValue(pdfBuffer)
    vi.mocked(saveFile).mockResolvedValue({ storagePath: "/uploads/abc.pdf", fileSize: 999 })
    vi.mocked(prisma.clientDocument.create).mockImplementation(((args: { data: object }) =>
      Promise.resolve({ id: "doc1", ...args.data })) as typeof prisma.clientDocument.create)
    vi.mocked(prisma.documentAccessLog.create).mockResolvedValue({} as never)

    const result = await generateDocument({
      tenantId: "t1",
      templateKey: "welcome-letter",
      clientId: "c1",
      staffUserId: "u1",
    })

    expect(htmlToPdf).toHaveBeenCalledWith("<p>Hello Thabo M</p>")

    expect(prisma.clientDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "t1",
          clientId: "c1",
          docType: "OTHER",
          fileName: "Welcome Letter.pdf",
          mimeType: "application/pdf",
          storagePath: "/uploads/abc.pdf",
          fileSize: 999,
          uploadedByType: "staff",
          uploadedById: "u1",
          templateId: "tpl1",
          generatedFromVersionId: "v1",
        }),
      })
    )

    expect(prisma.documentAccessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          documentId: "doc1",
          accessorType: "staff",
          accessorId: "u1",
          action: "generated",
        }),
      })
    )

    expect(result).toEqual({ clientDocumentId: "doc1", buffer: pdfBuffer })
  })
})

describe("generateDocument — CUSTOM, missing token", () => {
  it("throws MissingTokenError and performs no generation or persistence", async () => {
    mockCommonLookups()
    vi.mocked(prisma.documentTemplate.findFirst).mockResolvedValue(CUSTOM_TEMPLATE as never)
    vi.mocked(prisma.documentTemplateVersion.findFirst).mockResolvedValue({
      id: "v1",
      templateId: "tpl1",
      version: 1,
      bodyHtml: "<p>Loan reference: {{loan.reference}}</p>",
      status: "ACTIVE",
    } as never)

    const promise = generateDocument({
      tenantId: "t1",
      templateKey: "welcome-letter",
      clientId: "c1",
    })

    await expect(promise).rejects.toThrow(MissingTokenError)
    await promise.catch((err: MissingTokenError) => {
      expect(err.missing).toEqual(["loan.reference"])
    })

    expect(htmlToPdf).not.toHaveBeenCalled()
    expect(saveFile).not.toHaveBeenCalled()
    expect(prisma.clientDocument.create).not.toHaveBeenCalled()
    expect(prisma.documentAccessLog.create).not.toHaveBeenCalled()
  })
})

describe("generateDocument — SYSTEM", () => {
  it("dispatches to the SYSTEM_GENERATORS entry and creates a ClientDocument, without calling htmlToPdf", async () => {
    mockCommonLookups()
    vi.mocked(prisma.documentTemplate.findFirst).mockResolvedValue(SYSTEM_TEMPLATE as never)
    const pdfBuffer = Buffer.from("%PDF-system")
    vi.mocked(SYSTEM_GENERATORS.creditAgreement).mockResolvedValue(pdfBuffer)
    vi.mocked(saveFile).mockResolvedValue({ storagePath: "/uploads/sys.pdf", fileSize: 500 })
    vi.mocked(prisma.clientDocument.create).mockImplementation(((args: { data: object }) =>
      Promise.resolve({ id: "doc2", ...args.data })) as typeof prisma.clientDocument.create)
    vi.mocked(prisma.documentAccessLog.create).mockResolvedValue({} as never)

    const result = await generateDocument({
      tenantId: "t1",
      templateKey: "credit-agreement",
      clientId: "c1",
      staffUserId: "u1",
    })

    expect(SYSTEM_GENERATORS.creditAgreement).toHaveBeenCalledWith(
      expect.objectContaining({ tenant, client })
    )
    expect(htmlToPdf).not.toHaveBeenCalled()

    expect(prisma.clientDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          docType: "OTHER",
          templateId: "tpl_sys",
          generatedFromVersionId: null,
        }),
      })
    )
    expect(prisma.documentTemplateVersion.findFirst).not.toHaveBeenCalled()

    expect(result).toEqual({ clientDocumentId: "doc2", buffer: pdfBuffer })
  })
})

describe("generateDocument — allowSystem: false", () => {
  it("throws SystemGenerationNotAllowedError for a SYSTEM template and performs no generation or persistence", async () => {
    mockCommonLookups()
    vi.mocked(prisma.documentTemplate.findFirst).mockResolvedValue(SYSTEM_TEMPLATE as never)

    const promise = generateDocument({
      tenantId: "t1",
      templateKey: "credit-agreement",
      clientId: "c1",
      staffUserId: "u1",
      allowSystem: false,
    })

    await expect(promise).rejects.toThrow(SystemGenerationNotAllowedError)

    expect(SYSTEM_GENERATORS.creditAgreement).not.toHaveBeenCalled()
    expect(htmlToPdf).not.toHaveBeenCalled()
    expect(saveFile).not.toHaveBeenCalled()
    expect(prisma.clientDocument.create).not.toHaveBeenCalled()
    expect(prisma.documentAccessLog.create).not.toHaveBeenCalled()
  })

  it("still generates a CUSTOM document when allowSystem is false", async () => {
    mockCommonLookups()
    vi.mocked(prisma.documentTemplate.findFirst).mockResolvedValue(CUSTOM_TEMPLATE as never)
    vi.mocked(prisma.documentTemplateVersion.findFirst).mockResolvedValue({
      id: "v1",
      templateId: "tpl1",
      version: 1,
      bodyHtml: "<p>Hello {{client.fullName}}</p>",
      status: "ACTIVE",
    } as never)
    const pdfBuffer = Buffer.from("%PDF-custom")
    vi.mocked(htmlToPdf).mockResolvedValue(pdfBuffer)
    vi.mocked(saveFile).mockResolvedValue({ storagePath: "/uploads/abc.pdf", fileSize: 999 })
    vi.mocked(prisma.clientDocument.create).mockImplementation(((args: { data: object }) =>
      Promise.resolve({ id: "doc1", ...args.data })) as typeof prisma.clientDocument.create)
    vi.mocked(prisma.documentAccessLog.create).mockResolvedValue({} as never)

    const result = await generateDocument({
      tenantId: "t1",
      templateKey: "welcome-letter",
      clientId: "c1",
      staffUserId: "u1",
      allowSystem: false,
    })

    expect(result).toEqual({ clientDocumentId: "doc1", buffer: pdfBuffer })
  })

  it("still generates a SYSTEM document when allowSystem defaults to true", async () => {
    mockCommonLookups()
    vi.mocked(prisma.documentTemplate.findFirst).mockResolvedValue(SYSTEM_TEMPLATE as never)
    const pdfBuffer = Buffer.from("%PDF-system")
    vi.mocked(SYSTEM_GENERATORS.creditAgreement).mockResolvedValue(pdfBuffer)
    vi.mocked(saveFile).mockResolvedValue({ storagePath: "/uploads/sys.pdf", fileSize: 500 })
    vi.mocked(prisma.clientDocument.create).mockImplementation(((args: { data: object }) =>
      Promise.resolve({ id: "doc2", ...args.data })) as typeof prisma.clientDocument.create)
    vi.mocked(prisma.documentAccessLog.create).mockResolvedValue({} as never)

    const result = await generateDocument({
      tenantId: "t1",
      templateKey: "credit-agreement",
      clientId: "c1",
      staffUserId: "u1",
    })

    expect(SYSTEM_GENERATORS.creditAgreement).toHaveBeenCalled()
    expect(result).toEqual({ clientDocumentId: "doc2", buffer: pdfBuffer })
  })
})

describe("generateDocument — not found errors", () => {
  it("throws when the template doesn't exist", async () => {
    vi.mocked(prisma.documentTemplate.findFirst).mockResolvedValue(null)

    await expect(
      generateDocument({ tenantId: "t1", templateKey: "nope", clientId: "c1" })
    ).rejects.toThrow()

    expect(prisma.client.findFirst).not.toHaveBeenCalled()
  })

  it("throws the typed availability error when a CUSTOM template has no current version", async () => {
    mockCommonLookups()
    vi.mocked(prisma.documentTemplate.findFirst).mockResolvedValue({
      ...CUSTOM_TEMPLATE,
      currentVersionId: null,
    } as never)
    vi.mocked(prisma.documentTemplateVersion.findFirst).mockResolvedValue(null)

    await expect(generateDocument({
      tenantId: "t1",
      templateKey: "welcome-letter",
      clientId: "c1",
    })).rejects.toMatchObject({ name: "TemplateUnavailableError" })

    expect(htmlToPdf).not.toHaveBeenCalled()
    expect(prisma.clientDocument.create).not.toHaveBeenCalled()
  })

  it("throws the typed availability error for an inactive CUSTOM template before rendering", async () => {
    mockCommonLookups()
    vi.mocked(prisma.documentTemplate.findFirst).mockResolvedValue({
      ...CUSTOM_TEMPLATE,
      isActive: false,
    } as never)

    await expect(generateDocument({
      tenantId: "t1",
      templateKey: "welcome-letter",
      clientId: "c1",
    })).rejects.toMatchObject({ name: "TemplateUnavailableError" })

    expect(htmlToPdf).not.toHaveBeenCalled()
    expect(saveFile).not.toHaveBeenCalled()
    expect(prisma.clientDocument.create).not.toHaveBeenCalled()
    expect(prisma.documentAccessLog.create).not.toHaveBeenCalled()
  })

  it("binds a supplied loan to the selected client before rendering", async () => {
    mockCommonLookups()
    vi.mocked(prisma.documentTemplate.findFirst).mockResolvedValue(CUSTOM_TEMPLATE as never)
    vi.mocked(prisma.documentTemplateVersion.findFirst).mockResolvedValue({
      id: "v1",
      templateId: "tpl1",
      status: "ACTIVE",
    } as never)
    vi.mocked(prisma.loan.findFirst).mockResolvedValue(null)

    await expect(generateDocument({
      tenantId: "t1",
      templateKey: "welcome-letter",
      clientId: "c1",
      loanId: "foreign-loan",
    })).rejects.toThrow("Loan not found: foreign-loan")

    expect(prisma.loan.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign-loan", tenantId: "t1", clientId: "c1" },
    })
    expect(htmlToPdf).not.toHaveBeenCalled()
    expect(saveFile).not.toHaveBeenCalled()
    expect(prisma.clientDocument.create).not.toHaveBeenCalled()
    expect(prisma.documentAccessLog.create).not.toHaveBeenCalled()
  })

  it("binds a supplied application to the selected client before rendering", async () => {
    mockCommonLookups()
    vi.mocked(prisma.documentTemplate.findFirst).mockResolvedValue(CUSTOM_TEMPLATE as never)
    vi.mocked(prisma.documentTemplateVersion.findFirst).mockResolvedValue({
      id: "v1",
      templateId: "tpl1",
      status: "ACTIVE",
    } as never)
    vi.mocked(prisma.loanApplication.findFirst).mockResolvedValue(null)

    await expect(generateDocument({
      tenantId: "t1",
      templateKey: "welcome-letter",
      clientId: "c1",
      applicationId: "foreign-application",
    })).rejects.toThrow("Application not found: foreign-application")

    expect(prisma.loanApplication.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign-application", tenantId: "t1", clientId: "c1" },
      include: { product: true },
    })
    expect(htmlToPdf).not.toHaveBeenCalled()
    expect(saveFile).not.toHaveBeenCalled()
    expect(prisma.clientDocument.create).not.toHaveBeenCalled()
    expect(prisma.documentAccessLog.create).not.toHaveBeenCalled()
  })

  it("throws when the client doesn't exist", async () => {
    vi.mocked(prisma.documentTemplate.findFirst).mockResolvedValue(CUSTOM_TEMPLATE as never)
    vi.mocked(prisma.client.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue(tenant as never)

    await expect(
      generateDocument({ tenantId: "t1", templateKey: "welcome-letter", clientId: "missing" })
    ).rejects.toThrow()

    expect(prisma.clientDocument.create).not.toHaveBeenCalled()
  })
})
