import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  "Branch",
  "Client",
  "Loan",
  "LoanApplication",
  "Payment",
  "RepaymentSchedule",
  "LoanProduct",
  "PaymentArrangement",
  "ClientDocument",
  "LoanNote",
  "NotificationLog",
  "ComplianceRecord",
  "CreditBureauCheck",
  "Complaint",
  "DataSubjectRequest",
  "LoginLog",
  "Insurer",
  "CoiDeclaration",
  "TcfOutcome",
  "InsuranceProduct",
] as const)
