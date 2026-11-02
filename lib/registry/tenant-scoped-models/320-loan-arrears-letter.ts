import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // An arrears letter of a key-facts loan (lib/non-nca-documents/arrears-letter.ts).
  "LoanArrearsLetter",
  // A key facts statement, offer letter or loan agreement issued for an application (lib/non-nca-documents/issue.ts).
  "LoanDocumentIssuance",
] as const)
