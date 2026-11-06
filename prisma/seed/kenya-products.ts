// The Kenyan demo lender's products (DEMO_LENDER=nairobi), amounts in KES cents. Synthetic pricing for a
// demo, not a Kenyan lender's approved terms; UNVERIFIED against any Central Bank of Kenya product approval.
// The South African and Lesotho demo lenders keep PRODUCTS in prisma/seed.ts. DEMO_CBK_APPROVAL_REF is a placeholder
// printed on the key facts statement where a real lender's CBK product approval reference goes: no approval exists.
const DEMO_CBK_APPROVAL_REF = "CBK/DEMO/0001"
export const PRODUCTS_KE = [
  // Fixed 30-day term (min == max): the Apply form hides the term field. Repaid by M-Pesa Paybill.
  { code: "MPESA30", name: "M-Pesa 30-Day Loan", productType: "MICRO", minAmount: 100_000, maxAmount: 5_000_000, minTermDays: 30, maxTermDays: 30, interestRatePm: 0.04, interestModel: "DAILY_ACCRUAL", initiationFeePct: 0.05, initiationFeeMax: 250_000, monthlyServiceFee: 0, regulatorApprovalRef: DEMO_CBK_APPROVAL_REF },
  { code: "PERSONAL", name: "Personal Loan", productType: "PERSONAL", minAmount: 1_000_000, maxAmount: 50_000_000, minTermDays: 90, maxTermDays: 1_800, interestRatePm: 0.0175, interestModel: "REDUCING_BALANCE", initiationFeePct: 0.03, initiationFeeMax: 1_500_000, monthlyServiceFee: 0, regulatorApprovalRef: DEMO_CBK_APPROVAL_REF },
] as const
