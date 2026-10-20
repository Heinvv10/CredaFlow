import { beforeEach } from "vitest"

// The SMS channel is OFF unless BULKSMS_DRY_RUN is exactly "false"
// (lib/messaging/sms-channel.ts). Many suites exercise a live SMS leg, and
// several of them `delete` the variable in an afterEach, which would now leave
// every later test in that file with the channel off. Reset the opt-in before
// each test; a test that needs the default (unset) or "true" sets it itself.
// Nothing reaches the wire either way: lib/integrations/bulksms.ts treats
// NODE_ENV=test as a dry-run.
beforeEach(() => {
  process.env.BULKSMS_DRY_RUN = "false"
})
