import { defineChangeHandlers } from "../define"

export default defineChangeHandlers([
  { kind: "APPROVAL_MATRIX", module: "@/lib/approval/change-handler", export: "approvalMatrixHandler" },
] as const)
