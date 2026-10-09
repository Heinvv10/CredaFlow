const OUTBOUND_NOT_SENT = new Set([
  "FAILED",
  "FAILED_PERMANENT",
  "BOUNCED",
  "EXPIRED",
  "SUPPRESSED_BY_CONSENT",
])

export function leadMessageHeadline(args: {
  channelLabel: string
  direction: string
  status: string
}): string {
  if (args.direction !== "OUTBOUND") return `${args.channelLabel} received`
  if (args.status === "SIMULATED") return `${args.channelLabel} simulated — not sent`
  if (args.status === "QUEUED") return `${args.channelLabel} queued`
  if (args.status === "RETRYING") return `${args.channelLabel} retrying`
  if (OUTBOUND_NOT_SENT.has(args.status)) return `${args.channelLabel} not sent`
  if (["SENT", "DELIVERED", "READ"].includes(args.status)) return `${args.channelLabel} sent`
  return `${args.channelLabel} outbound`
}
