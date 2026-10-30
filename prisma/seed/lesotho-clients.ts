// The Lesotho demo lender's borrowers (DEMO_LENDER=basotho). Synthetic: IDs
// 99000000n that match no real card, 000 phone exchanges, "Demo Bank". A
// Lesotho ID's layout is unconfirmed (lib/jurisdiction/national-id.ts), so
// these only satisfy its shape check.
export const CLIENTS_LS = [
  { firstName: "Thabo", lastName: "Mokoena", idNumber: "990000001", dob: "1985-03-01", gender: "MALE", phone: "+26658000001", income: 2_800_000, expenses: 1_200_000, bank: "Demo Bank", acc: "62000012345", branch: "100001", city: "Maseru", prov: "MS", postal: "100" },
  { firstName: "Palesa", lastName: "Letsie", idNumber: "990000002", dob: "1992-05-01", gender: "FEMALE", phone: "+26662000002", income: 1_850_000, expenses: 900_000, bank: "Demo Bank", acc: "001234567", branch: "100001", city: "Maseru", prov: "MS", postal: "100" },
  { firstName: "Tumelo", lastName: "Sekhonyana", idNumber: "990000003", dob: "1978-12-01", gender: "MALE", phone: "+26658000003", income: 4_500_000, expenses: 2_100_000, bank: "Demo Bank", acc: "1357924680", branch: "100001", city: "Hlotse", prov: "LE", postal: "300" },
  { firstName: "Lineo", lastName: "Ramokoena", idNumber: "990000004", dob: "1994-01-01", gender: "FEMALE", phone: "+26662000004", income: 2_100_000, expenses: 850_000, bank: "Demo Bank", acc: "1986543210", branch: "100001", city: "Teyateyaneng", prov: "BE", postal: "200" },
  { firstName: "Mpho", lastName: "Thamae", idNumber: "990000005", dob: "1988-06-01", gender: "MALE", phone: "+26658000005", income: 3_200_000, expenses: 1_400_000, bank: "Demo Bank", acc: "4072345678", branch: "100001", city: "Mafeteng", prov: "MF", postal: "900" },
] as const
