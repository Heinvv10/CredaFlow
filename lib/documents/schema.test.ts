import { describe, it, expect } from "vitest"
import { Prisma } from "@prisma/client"

describe("DocumentTemplate schema", () => {
  it("generates the DocumentTemplate and DocumentTemplateVersion models", () => {
    expect(Prisma.ModelName.DocumentTemplate).toBeDefined()
    expect(Prisma.ModelName.DocumentTemplateVersion).toBeDefined()
  })
})
