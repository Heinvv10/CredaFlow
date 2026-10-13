import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"

/** A minimal valid tenant config file (synthetic lender; none of these is a real registration). */
export const validFile = () => ({
  slug: "staging-lender",
  name: "Staging Lender (Pty) Ltd",
  identity: { ...VALID_LENDER_COLUMNS, legalName: "Staging Lender (Pty) Ltd", brandName: "Staging Lender" },
  statutoryConfirm: {
    ncrNumber: VALID_LENDER_COLUMNS.ncrNumber,
    fscaNumber: VALID_LENDER_COLUMNS.fscaNumber,
    companyRegNumber: VALID_LENDER_COLUMNS.companyRegNumber,
  },
})
