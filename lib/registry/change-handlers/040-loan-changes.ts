import { defineChangeHandlers } from "../define"

export default defineChangeHandlers([
  { kind: "LOAN_CHANGE", module: "@/lib/loan-changes/handler", export: "loanChangeHandler" },
] as const)
