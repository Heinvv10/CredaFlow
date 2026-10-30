import { defineNcaOnlySurfaces } from "@/lib/jurisdiction/nca-only-registry"

// Documents that print the lender's NCR number: they refuse to render without one.
export default defineNcaOnlySurfaces({
  "app/api/loans/[id]/certificate-of-balance/route.ts": {
    gate: "via",
    reason: "the certificate prints NCR Reg and requireLenderIdentityFields refuses a lender with no NCR number",
    proof: [
      { file: "lib/pdf/certificateOfBalance.ts", contains: 'requireLenderIdentityFields(opts.lender, ["legalName", "ncrNumber"])' },
      { file: "lib/config/identity-schema.ts", contains: 'field === "ncrNumber") && (stored ?? null) === null' },
    ],
  },
  "app/api/documents/generate/route.ts": {
    gate: "via",
    reason: "templates take lender facts through tokens; tenant.ncrNumber resolves to null for an LS lender, so a template that needs it is refused as a missing token (422)",
    proof: [{ file: "lib/documents/tokens.ts", contains: "resolve: (ctx) => ctx.lender?.ncrNumber ?? null" }],
  },
})
