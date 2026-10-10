/**
 * Vocabulary the persona builder draws from.
 *
 * Employers, creditors and street names are INVENTED compounds chosen to read
 * as plausible South African businesses without naming a real one. Towns,
 * postal codes and provinces are real (the address must pass the wizard's
 * 4-digit/province checks and look right on a map). Banks are real names and
 * real universal branch codes; account numbers are synthetic (see build.ts).
 */
import type { PersonaBankCode, ProvinceCode } from './types'

export const FEMALE_FIRST_NAMES = [
  'Lerato', 'Naledi', 'Zanele', 'Busisiwe', 'Palesa', 'Refilwe', 'Nandi', 'Kholiwe',
  'Lindiwe', 'Anele', 'Charmaine', 'Anika', 'Elize', 'Fatima', 'Shireen', 'Priya',
  'Kavitha', 'Tshegofatso', 'Dineo', 'Nokuthula', 'Siphokazi', 'Yolanda', 'Thembeka',
  'Rethabile', 'Bontle', 'Mbali', 'Zinhle', 'Michelle',
] as const

export const MALE_FIRST_NAMES = [
  'Thabo', 'Mandla', 'Kagiso', 'Tumelo', 'Lwazi', 'Themba', 'Vusi', 'Andile', 'Musa',
  'Pieter', 'Ruan', 'Ebrahim', 'Yusuf', 'Rajesh', 'Kevin', 'Brandon', 'Lethabo',
  'Tshepo', 'Kabelo', 'Siyabonga', 'Xolani', 'Bheki', 'Mxolisi', 'Teboho', 'Jabulani',
  'Riaan', 'Dumisani', 'Neo',
] as const

export const SURNAMES = [
  'Mokoena', 'Molefe', 'Mahlangu', 'Sithole', 'Mabaso', 'Naidoo', 'Pillay', 'Botha',
  'Jacobs', 'Adams', 'Hendricks', 'Petersen', 'Mthethwa', 'Ngcobo', 'Cele', 'Radebe',
  'Maseko', 'Tshabalala', 'Motaung', 'Letsoalo', 'Baloyi', 'Maluleke', 'Nkuna', 'Chauke',
  'Mabunda', 'Shabalala', 'Gumede', 'Majola', 'Moloi', 'Kekana', 'Mashaba', 'Fourie',
  'Coetzee', 'Abrahams', 'Moodley', 'Govender', 'van Wyk', 'Steyn',
] as const

/** prisma/seed.ts clients — never reuse their names, the demo DB holds both. */
export const RESERVED_FULL_NAMES = new Set([
  'Sipho Nkosi', 'Nomvula Dlamini', 'Bongani Zulu', 'Thandi Mthembu', 'Lungelo Khumalo',
])

export interface EmployerDef {
  name: string
  /** What a bank statement prints in the salary narrative. */
  shortName: string
  occupations: readonly string[]
  /** Street part of the employer address; the town is the persona's. */
  street: string
  /** Gross monthly salary band, rands. */
  grossBand: readonly [number, number]
}

export const EMPLOYERS: readonly EmployerDef[] = [
  { name: 'Thornveld Cobalt Logistics (Pty) Ltd', shortName: 'THORNVELD COBALT', occupations: ['Dispatch Controller', 'Fleet Administrator', 'Warehouse Supervisor'], street: '14 Depot Road', grossBand: [16000, 34000] },
  { name: 'Sandkop Ridge Poultry (Pty) Ltd', shortName: 'SANDKOP RIDGE', occupations: ['Production Operator', 'Quality Controller', 'Shift Supervisor'], street: '3 Hatchery Lane', grossBand: [11000, 24000] },
  { name: 'Bluegum Kettle Catering CC', shortName: 'BLUEGUM KETTLE', occupations: ['Chef de Partie', 'Catering Assistant', 'Events Coordinator'], street: '88 Scullery Street', grossBand: [10000, 21000] },
  { name: 'Ironbark Valley Security Services (Pty) Ltd', shortName: 'IRONBARK VALLEY', occupations: ['Security Officer', 'Control Room Operator', 'Site Supervisor'], street: '21 Watchtower Avenue', grossBand: [12000, 22000] },
  { name: 'Marula Quay Retail (Pty) Ltd', shortName: 'MARULA QUAY', occupations: ['Store Manager', 'Sales Associate', 'Stock Controller'], street: '5 Arcade Walk', grossBand: [11000, 30000] },
  { name: 'Kestrel Lane Healthcare Group (Pty) Ltd', shortName: 'KESTREL LANE HC', occupations: ['Professional Nurse', 'Pharmacy Assistant', 'Ward Administrator'], street: '40 Infirmary Drive', grossBand: [18000, 42000] },
  { name: 'Amberglen Civil Contractors (Pty) Ltd', shortName: 'AMBERGLEN CIVIL', occupations: ['Site Foreman', 'Plant Operator', 'Quantity Surveyor'], street: '9 Gravelpit Road', grossBand: [15000, 45000] },
  { name: 'Quillfield Contact Solutions (Pty) Ltd', shortName: 'QUILLFIELD CS', occupations: ['Call Centre Agent', 'Team Leader', 'Workforce Analyst'], street: '120 Headset Boulevard', grossBand: [9500, 26000] },
  { name: 'Pebblecrest Schools Trust', shortName: 'PEBBLECREST TRUST', occupations: ['Teacher', 'Bursar', 'Teaching Assistant'], street: '7 Chalkboard Close', grossBand: [14000, 36000] },
  { name: 'Zinnia Freight Lines (Pty) Ltd', shortName: 'ZINNIA FREIGHT', occupations: ['Long-haul Driver', 'Route Planner', 'Customs Clerk'], street: '62 Weighbridge Street', grossBand: [14000, 32000] },
  { name: 'Highkloof Engineering Works (Pty) Ltd', shortName: 'HIGHKLOOF ENG', occupations: ['Fitter and Turner', 'Boilermaker', 'Maintenance Planner'], street: '17 Lathe Street', grossBand: [17000, 40000] },
  { name: 'Sunbird Valley Agri Co-op Ltd', shortName: 'SUNBIRD VALLEY', occupations: ['Farm Manager', 'Irrigation Technician', 'Pack-house Clerk'], street: '1 Silo Road', grossBand: [10000, 28000] },
] as const

export interface TownDef {
  city: string
  province: ProvinceCode
  postalCode: string
  suburbs: readonly string[]
}

export const TOWNS: readonly TownDef[] = [
  { city: 'Johannesburg', province: 'GP', postalCode: '2001', suburbs: ['Braamfontein', 'Marshalltown'] },
  { city: 'Soweto', province: 'GP', postalCode: '1804', suburbs: ['Orlando West', 'Protea Glen'] },
  { city: 'Pretoria', province: 'GP', postalCode: '0002', suburbs: ['Arcadia', 'Sunnyside'] },
  { city: 'Tembisa', province: 'GP', postalCode: '1632', suburbs: ['Ivory Park', 'Birch Acres'] },
  { city: 'Durban', province: 'KZN', postalCode: '4001', suburbs: ['Morningside', 'Berea'] },
  { city: 'Pietermaritzburg', province: 'KZN', postalCode: '3201', suburbs: ['Scottsville', 'Pelham'] },
  { city: 'Cape Town', province: 'WC', postalCode: '8001', suburbs: ['Woodstock', 'Gardens'] },
  { city: 'Bellville', province: 'WC', postalCode: '7530', suburbs: ['Oakdale', 'Boston'] },
  { city: 'Gqeberha', province: 'EC', postalCode: '6001', suburbs: ['Newton Park', 'Walmer'] },
  { city: 'East London', province: 'EC', postalCode: '5201', suburbs: ['Vincent', 'Southernwood'] },
  { city: 'Bloemfontein', province: 'FS', postalCode: '9301', suburbs: ['Westdene', 'Willows'] },
  { city: 'Polokwane', province: 'LP', postalCode: '0700', suburbs: ['Bendor', 'Westenburg'] },
  { city: 'Mbombela', province: 'MP', postalCode: '1200', suburbs: ['Sonheuwel', 'West Acres'] },
  { city: 'Rustenburg', province: 'NW', postalCode: '0300', suburbs: ['Safari Gardens', 'Cashan'] },
  { city: 'Kimberley', province: 'NC', postalCode: '8301', suburbs: ['Belgravia', 'Hadison Park'] },
] as const

/** Invented street names; numbers are added per persona. */
export const STREETS = [
  'Umsobo Lane', 'Tamboti Close', 'Kiaat Crescent', 'Sneezewood Street', 'Ouhout Avenue',
  'Wild Fig Road', 'Kingklip Way', 'Rooibos Terrace', 'Fynbos Mews', 'Klipspringer Drive',
  'Gwarrie Street', 'Bushwillow Close', 'Ilala Palm Road', 'Moepel Lane', 'Kudu Horn Street',
] as const

export interface BankDef {
  code: PersonaBankCode
  /** Printed on the statement; canonicalBankName() must resolve it to the code. */
  displayName: string
  universalBranchCode: string
  /** Leading digits for the synthetic account number, and its total length. */
  accountPrefix: string
  accountLength: number
}

export const BANKS: readonly BankDef[] = [
  { code: 'ABSA', displayName: 'ABSA Bank', universalBranchCode: '632005', accountPrefix: '409', accountLength: 10 },
  { code: 'FNB', displayName: 'First National Bank', universalBranchCode: '250655', accountPrefix: '629', accountLength: 11 },
  { code: 'NEDBANK', displayName: 'Nedbank', universalBranchCode: '198765', accountPrefix: '119', accountLength: 10 },
  { code: 'STANDARD_BANK', displayName: 'Standard Bank', universalBranchCode: '051001', accountPrefix: '109', accountLength: 9 },
  { code: 'CAPITEC', displayName: 'Capitec Bank', universalBranchCode: '470010', accountPrefix: '149', accountLength: 10 },
  { code: 'TYME_BANK', displayName: 'TymeBank', universalBranchCode: '678910', accountPrefix: '519', accountLength: 11 },
] as const

export function bankDef(code: PersonaBankCode): BankDef {
  const def = BANKS.find((b) => b.code === code)
  if (!def) throw new Error(`unknown bank ${code}`)
  return def
}

/** Invented credit providers by debt type. */
export const CREDITORS = {
  HOME_LOAN: ['Ridgeline Home Finance'],
  VEHICLE_FINANCE: ['Wayfarer Vehicle Finance', 'Odometer Motor Credit'],
  PERSONAL_LOAN: ['Bluecrane Personal Loans', 'Harbourlight Credit'],
  CREDIT_CARD: ['Copperleaf Card Services'],
  STORE_ACCOUNT: ['Homestead Furnishers Account', 'Brightway Appliances Account'],
  CLOTHING_ACCOUNT: ['Threadline Fashion Account', 'Stitchwell Clothing Account'],
  MICROFINANCE: ['Quickmoss Cash Loans', 'Pocketwise Microlending'],
} as const
