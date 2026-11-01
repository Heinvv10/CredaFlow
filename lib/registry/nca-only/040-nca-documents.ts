import { defineNcaOnlySurfaces } from "@/lib/jurisdiction/nca-only-registry"

// Documents that print the lender's NCR number: they refuse to render without one. (The statement, the certificate of balance and the
// debit mandate are not here: outside the NCA they print the company registration number and no South African statute.)
export default defineNcaOnlySurfaces({
  "app/api/documents/generate/route.ts": {
    gate: "via",
    reason: "templates take lender facts through tokens; tenant.ncrNumber resolves to null for an LS lender, so a template that needs it is refused as a missing token (422)",
    proof: [{ file: "lib/documents/tokens.ts", contains: "resolve: (ctx) => ctx.lender?.ncrNumber ?? null" }],
  },
})
