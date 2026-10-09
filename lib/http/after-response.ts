import { after } from "next/server"

// Run work once the HTTP response has been sent.
//
// Exists so that work whose DURATION would otherwise be observable to the
// caller cannot be timed. The returning-applicant notice is the motivating
// case: on a match it does a throttle write, a bell insert and a real SMTP
// send, and awaiting that made a recognised submission measurably slower than
// an unrecognised one — a timing oracle for the one fact the public apply route
// must never reveal.
//
// Next's after() is the right primitive because the runtime keeps the
// invocation alive until the task settles, so deferring does not mean dropping.
//
// The fallback matters. after() throws when there is no request context —
// unit tests calling a route handler directly, scripts, cron entrypoints. A
// bare throw there would turn "the notice could not be deferred" into "the
// request failed", which is precisely backwards for best-effort work. The
// fallback still does NOT await, so the timing property holds in every path.
export function deferAfterResponse(task: () => void | Promise<void>): void {
  try {
    after(task)
  } catch {
    void Promise.resolve()
      .then(task)
      .catch(() => undefined)
  }
}
