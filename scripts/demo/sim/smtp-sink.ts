/**
 * The sim stack's outbound mail server: accepts every message the app sends
 * over SMTP and files it as an .eml under SIM_MAIL_DIR. Nothing is relayed.
 *
 * Why it exists: a Section 129 notice is issued only when the tenant's email
 * provider accepts it (app/api/loans/section129/route.ts), and an attorney
 * referral needs an issued notice. The tenant is configured through
 * Settings → Email (POST /api/email/config) to send here, exactly as a lender
 * points the product at its own mail server. Every persona address is
 * @….invalid, so even a misrouted message could reach nobody.
 *
 * Speaks the subset nodemailer uses without TLS: EHLO/HELO, AUTH PLAIN/LOGIN
 * (any credentials), MAIL, RCPT, DATA, RSET, NOOP, QUIT. Runs in a container
 * on the sim network (smtp-sink.sh); progress goes to stderr.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import path from "node:path"

const PORT = Number(process.env.SMTP_SINK_PORT ?? "2525")
const MAIL_DIR = process.env.SIM_MAIL_DIR ?? "/mail"
const HOST = "credaflow-demo-sim-smtp"

let delivered = 0

function serve(socket: Socket): void {
  let buffer = ""
  let inData = false
  let authStep: "none" | "login-user" | "login-pass" = "none"
  let from = ""
  let to: string[] = []
  let message: string[] = []
  const reply = (line: string) => socket.write(`${line}\r\n`)

  const finishMessage = () => {
    delivered++
    const id = `${Date.now().toString(36)}-${delivered}`
    writeFileSync(path.join(MAIL_DIR, `${id}.eml`), `X-Sink-From: ${from}\r\nX-Sink-To: ${to.join(", ")}\r\n${message.join("\r\n")}\r\n`)
    process.stderr.write(`[smtp-sink] ${id} from=${from} to=${to.join(",")}\n`)
    reply(`250 2.0.0 OK queued as ${id}`)
    from = ""
    to = []
    message = []
  }

  const command = (line: string) => {
    if (authStep === "login-user") { authStep = "login-pass"; reply("334 UGFzc3dvcmQ6"); return }
    if (authStep === "login-pass") { authStep = "none"; reply("235 2.7.0 Authentication successful"); return }
    const verb = line.split(" ")[0].toUpperCase()
    switch (verb) {
      case "EHLO": reply(`250-${HOST}`); reply("250-AUTH PLAIN LOGIN"); reply("250-8BITMIME"); reply("250 SIZE 26214400"); break
      case "HELO": reply(`250 ${HOST}`); break
      case "AUTH":
        if (/^AUTH LOGIN$/i.test(line)) { authStep = "login-user"; reply("334 VXNlcm5hbWU6") }
        else if (/^AUTH LOGIN /i.test(line)) { authStep = "login-pass"; reply("334 UGFzc3dvcmQ6") }
        else if (/^AUTH PLAIN /i.test(line)) reply("235 2.7.0 Authentication successful")
        else reply("504 5.5.4 Unrecognised authentication type")
        break
      case "MAIL": from = line.replace(/^MAIL FROM:\s*/i, ""); reply("250 2.1.0 OK"); break
      case "RCPT": to.push(line.replace(/^RCPT TO:\s*/i, "")); reply("250 2.1.5 OK"); break
      case "DATA": inData = true; reply("354 End data with <CR><LF>.<CR><LF>"); break
      case "RSET": from = ""; to = []; message = []; reply("250 2.0.0 OK"); break
      case "NOOP": reply("250 2.0.0 OK"); break
      case "QUIT": reply("221 2.0.0 Bye"); socket.end(); break
      default: reply("502 5.5.2 Command not implemented")
    }
  }

  reply(`220 ${HOST} ESMTP sim sink`)
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    let eol: number
    while ((eol = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, eol)
      buffer = buffer.slice(eol + 2)
      if (inData) {
        if (line === ".") { inData = false; finishMessage() }
        else message.push(line.startsWith("..") ? line.slice(1) : line)
      } else {
        command(line)
      }
    }
  })
  socket.on("error", (err) => process.stderr.write(`[smtp-sink] socket error: ${err.message}\n`))
}

mkdirSync(MAIL_DIR, { recursive: true })
createServer(serve).listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`[smtp-sink] listening on :${PORT}, filing mail in ${MAIL_DIR}\n`)
})
