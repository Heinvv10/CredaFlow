// The Kenyan demo lender's borrowers (DEMO_LENDER=nairobi). Synthetic: IDs
// 99000001 to 99000005 that match no real card, +2547000000NN phones, "Demo
// Bank". A Kenyan ID's layout is UNVERIFIED (lib/jurisdiction/national-id.ts),
// so these only satisfy its shape check. `prov` is the county code
// (lib/jurisdiction/profiles.ts KENYA_COUNTIES); incomes are KES cents.
// Phones are written +254…: the seed runs with no jurisdiction loaded, and a
// local 0… number then gets no contact identity (lib/contact/identity.ts).
export const CLIENTS_KE = [
  { firstName: "Brian", lastName: "Otieno", idNumber: "99000001", dob: "1985-03-01", gender: "MALE", phone: "+254700000001", income: 4_500_000, expenses: 2_000_000, bank: "Demo Bank", acc: "62000012345", branch: "100001", city: "Nairobi", prov: "047", postal: "00100" },
  { firstName: "Faith", lastName: "Wanjiru", idNumber: "99000002", dob: "1992-05-01", gender: "FEMALE", phone: "+254700000002", income: 3_200_000, expenses: 1_500_000, bank: "Demo Bank", acc: "001234567", branch: "100001", city: "Kiambu", prov: "022", postal: "00900" },
  { firstName: "Kevin", lastName: "Mwangi", idNumber: "99000003", dob: "1978-12-01", gender: "MALE", phone: "+254700000003", income: 8_000_000, expenses: 3_600_000, bank: "Demo Bank", acc: "1357924680", branch: "100001", city: "Mombasa", prov: "001", postal: "80100" },
  { firstName: "Mercy", lastName: "Achieng", idNumber: "99000004", dob: "1994-01-01", gender: "FEMALE", phone: "+254700000004", income: 3_800_000, expenses: 1_600_000, bank: "Demo Bank", acc: "1986543210", branch: "100001", city: "Nairobi", prov: "047", postal: "00100" },
  { firstName: "Dennis", lastName: "Kiprono", idNumber: "99000005", dob: "1988-06-01", gender: "MALE", phone: "+254700000005", income: 5_500_000, expenses: 2_400_000, bank: "Demo Bank", acc: "4072345678", branch: "100001", city: "Thika", prov: "022", postal: "01000" },
] as const
