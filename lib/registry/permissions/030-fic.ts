import { definePermissions } from "../define"

// FIC Act tooling (lib/fic). No COMPLIANCE role exists; ADMIN stands in for
// the lender's compliance officer: the STR register, CTR filings, goAML
// exports and the RMCP. Raising an STR is open to every operational role
// (every employee must be able to report internally); seeing the register is
// not.
export default definePermissions({
  manage_fic_compliance: "ADMIN",
  raise_suspicious_report: "COLLECTIONS_OFFICER",
} as const)
