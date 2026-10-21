import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import type { AssetTrackerDevice } from "@/lib/telematics/devices"
import { TrackerDevicesPanel } from "./TrackerDevicesPanel"

// The asset's Tracker devices card (browser review of PR #222): a device that
// is not the asset's recorded tracker id is flagged amber with what to do; a
// real provider's unverified meter says it feeds no lease and offers the check.
const device = (over: Partial<AssetTrackerDevice> = {}): AssetTrackerDevice => ({
  deviceId: "d-1", provider: "simulated", externalDeviceId: "SIM-TAMPER-0001", simulated: true, lastSeenAt: null, matchesTrackerId: true,
  status: "ACTIVE", installedOn: "2030-06-01", removedOn: null, lastPollError: null, meterVerifiedAt: null, ...over,
})
const html = (devices: AssetTrackerDevice[], canManage = true) => renderToStaticMarkup(<TrackerDevicesPanel assetId="a-1" devices={devices} canManage={canManage} providers={[]} />)

describe("TrackerDevicesPanel", () => {
  it("flags a tracker id mismatch amber with its next action, and says nothing alarming when it matches", () => {
    const mismatch = html([device({ matchesTrackerId: false })])
    expect(mismatch).toContain("Tracker id mismatch")
    expect(mismatch).toContain("correct the Tracker unit ID under Payout readiness")
    const match = html([device()])
    expect(match).toContain("matches the recorded tracker id")
    expect(match).not.toContain("Tracker id mismatch")
  })

  it("offers a manager the meter check for a real provider's unverified device, and shows when one was verified", () => {
    const real = device({ provider: "acme", simulated: false })
    expect(html([real])).toContain("Meter not verified: its readings feed no lease")
    expect(html([real])).toContain("Verify meter")
    expect(html([real], false)).not.toContain("Verify meter")
    expect(html([device()])).not.toContain("Verify meter")
    expect(html([{ ...real, meterVerifiedAt: new Date("2030-06-02T10:00:00Z") }])).toContain("Meter verified")
  })
})
