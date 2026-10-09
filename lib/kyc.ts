export const CORE_DOC_TYPES = ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const
export type CoreDocType = (typeof CORE_DOC_TYPES)[number]
