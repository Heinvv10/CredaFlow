// NCA scope thresholds for asset finance (DESIGN D5). All amounts in CENTS.
//
// Source: the Minister's determination of thresholds under NCA s7(1) and
// s9(4), Government Notice R.713 in Government Gazette No. 28893 of
// 1 June 2006.
//  - Juristic-person threshold (s4(1)(a)(i)): a juristic consumer whose asset
//    value OR annual turnover equals or exceeds R1 000 000 is outside the Act.
//  - Large-agreement threshold (s9(4)(b)): a credit transaction whose principal
//    debt is at or above R250 000 is a large agreement; with a juristic
//    consumer below the R1m threshold it is outside the Act (s4(1)(b)).
// UNTESTED: citation to confirm with legal
export const NCA_JURISTIC_THRESHOLD_CENTS = 100_000_000
export const NCA_LARGE_AGREEMENT_THRESHOLD_CENTS = 25_000_000

// NCA s1, definition of "juristic person": it includes a trust with three or
// more individual trustees, or whose trustee is itself a juristic person. So a
// trust with fewer than this many trustees, ALL natural persons, is not a
// juristic person and the NCA applies to it in full.
// UNTESTED: citation to confirm with legal
export const NCA_TRUST_MIN_TRUSTEES_FOR_JURISTIC = 3
