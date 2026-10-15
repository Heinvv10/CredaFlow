/**
 * True only when a nodemailer SMTP failure PROVES no connection to the mail
 * server ever existed — so nothing was submitted and the send is safe to record
 * as not sent (and to retry) instead of holding it for manual reconciliation.
 *
 * `code` and `command` cannot tell us this. Measured against nodemailer 9 and 10: a
 * server that resets or drops the connection AFTER the message body was sent
 * reports `code: "ESOCKET"`/`"ECONNECTION"`/`"ETIMEDOUT"` with `command: "CONN"`
 * — exactly what a refused connection reports. Only these prove the phase:
 *
 * - `EDNS`: the host never resolved.
 * - `syscall: "connect"`: the TCP connect itself failed (refused, unreachable).
 *   A mid-session reset carries `syscall: "read"`/`"write"` instead.
 * - "Connection timeout" / "Greeting never received": nodemailer's connection
 *   and greeting timers are cleared on connect and on the server's 220
 *   greeting respectively, before any SMTP command is sent.
 *
 * A TLS "wrong version number" is deliberately NOT here: nothing on the error
 * proves it happened during the handshake rather than mid-session.
 */
export function smtpFailedBeforeConnection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const e = error as { code?: unknown; syscall?: unknown; message?: unknown }
  if (e.code === "EDNS") return true
  if (e.syscall === "connect") return true
  return e.code === "ETIMEDOUT" &&
    (e.message === "Connection timeout" || e.message === "Greeting never received")
}
