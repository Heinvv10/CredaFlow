/**
 * The words an advisory output may use (goal §2a.4). A blocklist of
 * reassurance can never be complete ("nothing out of the ordinary", "poses no
 * threat"), so the output is held to an allowlist instead: plain descriptive
 * words for statements, flags, rules and figures, and the names the facts
 * gave (payees, banks, categories, codes). No evaluative word is on it, so
 * no output can call anything fine, however it phrases it.
 *
 * Adding a word: it must describe, never judge. Calibrate with the
 * evaluation (scripts/statement-ai/eval.ts prints the words it rejected).
 */

const WORDS = `
a an the this that these those it its they them their there here which who whose what when where while
of to in on at by for from with into onto per via across between during within through over under after before
since until than as also and or but both either each every all any some more most less least only just
is are was were be been being has have had having do does did done
can could may might will would shall should
i we you he she his her our your
one two three four five six seven eight nine ten
first second last next previous same other another such

statement statements bank banks account accounts holder holders period periods cover covers covered covering
date dates day days week weeks month months monthly year years
from to between start end ends ended ending starts started opening closing
balance balances average averages averaged lowest highest largest smallest biggest top
money in out income incoming outgoing inflow inflows outflow outflows net gross
salary salaries wage wages pay pays paid payment payments payer payee payees paying
credit credits credited debit debits debited order orders instalment instalments
transfer transfers transferred deposit deposits deposited withdrawal withdrawals withdrew withdrawn
receive receives received receiving spend spends spent spending
total totals totalled totaled totalling totaling sum sums count counts counted number numbers amount amounts
figure figures value values share shares percentage percent cent proportion
row rows reference references ref refs line lines entry entries item items transaction transactions
category categories categorised uncategorised categorized uncategorized living
food transport housing rent education insurance clothing entertainment medical utilities telecom
fees fee charges charge cash savings investment investments
gambling betting bet bets lottery
loan loans lender lenders lending provider providers finance short term short-term debt debts
declared declaration declare reported report reports bureau
expense expenses cost costs
difference differs differ compared compares compare comparing comparison against relative
above below higher lower greater larger smaller exceeds exceeded exceeding exceed short
flag flags flagged raised raises raise rule rules check checks checked checking checker
policy threshold thresholds tolerance tolerances limit limits maximum minimum match matches matched matching
evidence shows show showed shown listed lists list cited cites cite includes include included including
officer officers credit-officer review reviews reviewed reviewing manual manually hand
client clients applicant applicants application applications
payslip payslips document documents pdf file files producer creator program software
created creation modified modification saved saves save written write writes printed prints print
reconciled reconcile reconciles reconciling reconciliation
returned return returns unpaid collected collect collection attempt attempts
recurring repeated
read reads named name names
found find finds located
time
question questions answer answers query queries result results computed calculated
appear appears appeared
whether because so if then
came come comes went go goes going made make makes individual individually separate separately
against indicate indicates indicated indicating resulting result
undisclosed disclosed recent recently whole part parts process processes showing entire full overall period's whose presence present absence absent available on
`

/** Every allowed word, lower case. */
export const VOCABULARY: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean))

/**
 * The only negations allowed, each with a fixed subject: a rule that could
 * not check something, a document that is missing, or the flag's own finding
 * (a debit order matched to no declared debt). "Not", "never", "nothing" and
 * the like are otherwise outside the vocabulary: a negated finding ("is not a
 * concern", "requires no follow-up") is how reassurance hides.
 */
export const ALLOWED_NEGATIONS = new RegExp([
  "\\b(salary|salary credit|net pay|income|credit) (could not be|cannot be|was not|is not) (matched|checked|verified against a payslip)\\b",
  "\\b(statement|document|row|rows|first row|last row|transaction|transactions|balance|balances|period) (could not be|cannot be|was not|were not|is not|are not) (read|checked|dated|reconciled|matched)\\b",
  "\\b(debit order|debit orders|instalment|instalments|payment|payments) (is|are|was|were) not matched\\b",
  "\\bno (recent )?(payslip|statement|opening balance|closing balance|running balance|producer|creator)\\b",
  "\\b(could|can) be verified against a payslip\\b",
].join("|"), "gi")
