/**
 * The figure check: every figure in a rendered text must be one the facts or
 * a query result gave, written exactly as given (post-check-figures.ts). Code
 * writes every sentence (render.ts), so it guards against a render bug.
 */
export { checkFigures } from "./post-check-figures"
export { checkNoContradiction } from "./post-check-language"
export { fail, norm, OK, stripLiterals, type Allowed, type CheckResult } from "./post-check-core"
