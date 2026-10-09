"use client"

import { useEffect, useState } from "react"
import { CheckCircle, Info, MessageCircle, Send, XCircle } from "lucide-react"

/**
 * Meta Embedded Signup (JS SDK) glue — browser-only. Requires a Meta
 * Tech-Provider app that has passed App Review for whatsapp_business_management
 * + whatsapp_business_messaging; that setup is external to this repo (Hein).
 * NOT unit-tested — verified live per Task 11 Step 10. Minimal shape of the
 * SDK global, loaded lazily via <script>, not covered by @types.
 */
declare global {
  interface Window {
    fbAsyncInit?: () => void
    FB?: {
      init: (params: { appId: string; version: string }) => void
      login: (
        callback: (response: { authResponse?: { code?: string } }) => void,
        params: { config_id: string; response_type: "code"; override_default_response_type: true }
      ) => void
    }
  }
}

const META_GRAPH_VERSION = "v23.0"
const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID
const META_ES_CONFIG_ID = process.env.NEXT_PUBLIC_META_ES_CONFIG_ID

export function CloudApiTab({ waProvider, wabaPhoneNumberId }: { waProvider?: string; wabaPhoneNumberId?: string | null }) {
  const [testPhone, setTestPhone] = useState("")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    simulated?: boolean
    message: string
  } | null>(null)

  // Embedded Signup: the auth `code` arrives via the FB.login callback; the
  // `waba_id`/`phone_number_id` arrive separately via a window "message" event
  // the SDK posts during the flow. Both must land before we can POST.
  const [esCode, setEsCode] = useState<string | null>(null)
  const [esIds, setEsIds] = useState<{ wabaId: string; phoneNumberId: string } | null>(null)
  const [esConnecting, setEsConnecting] = useState(false)
  const [esResult, setEsResult] = useState<{ ok: boolean; message: string } | null>(null)

  // Connection status: seeded from server props, updated locally on disconnect
  // so the UI reflects the change without a full page reload.
  const [waNumber, setWaNumber] = useState(wabaPhoneNumberId ?? null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)

  // Load the Meta JS SDK once and initialise it against our Tech-Provider app.
  useEffect(() => {
    if (!META_APP_ID || document.getElementById("facebook-jssdk")) return
    window.fbAsyncInit = () => {
      window.FB?.init({ appId: META_APP_ID, version: META_GRAPH_VERSION })
    }
    const script = document.createElement("script")
    script.id = "facebook-jssdk"
    script.src = "https://connect.facebook.net/en_US/sdk.js"
    script.async = true
    document.body.appendChild(script)
  }, [])

  // Capture waba_id/phone_number_id posted by the embedded signup iframe.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== "https://www.facebook.com") return
      try {
        const data = JSON.parse(event.data)
        if (data.type === "WA_EMBEDDED_SIGNUP" && data.event === "FINISH") {
          setEsIds({ wabaId: data.data?.waba_id, phoneNumberId: data.data?.phone_number_id })
        }
      } catch {
        // Not a JSON payload for us — ignore.
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  // Once we have both the code and the ids, complete the signup server-side.
  useEffect(() => {
    if (!esCode || !esIds) return
    setEsConnecting(true)
    setEsResult(null)
    fetch("/api/settings/whatsapp/embedded-signup", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: esCode, wabaId: esIds.wabaId, phoneNumberId: esIds.phoneNumberId }),
    })
      .then(async (res) => {
        const data = await res.json() as { ok?: boolean; error?: string }
        if (res.ok && data.ok) {
          setEsResult({ ok: true, message: "WhatsApp Cloud API connected." })
          // Reflect the new connection in the status card without a page reload,
          // symmetric with handleDisconnect's setWaNumber(null).
          setWaNumber(esIds.phoneNumberId)
        } else {
          setEsResult({ ok: false, message: data.error ?? "Failed to connect" })
        }
      })
      .catch(() => setEsResult({ ok: false, message: "Network error" }))
      .finally(() => {
        setEsConnecting(false)
        setEsCode(null)
        setEsIds(null)
      })
  }, [esCode, esIds])

  const handleConnectWhatsApp = () => {
    if (!window.FB || !META_ES_CONFIG_ID) return
    window.FB.login(
      (response) => {
        const code = response.authResponse?.code
        if (code) setEsCode(code)
      },
      { config_id: META_ES_CONFIG_ID, response_type: "code", override_default_response_type: true }
    )
  }

  const handleDisconnect = async () => {
    setDisconnecting(true)
    setDisconnectError(null)
    try {
      const res = await fetch("/api/settings/whatsapp", { method: "DELETE" })
      if (res.ok) {
        setWaNumber(null)
      } else {
        setDisconnectError("Failed to disconnect")
      }
    } catch {
      setDisconnectError("Network error")
    } finally {
      setDisconnecting(false)
    }
  }

  const handleTest = async () => {
    if (!testPhone.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch("/api/settings/whatsapp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: testPhone }),
      })
      const data = await res.json() as {
        ok?: boolean
        error?: string
        messageId?: string
        simulated?: boolean
      }
      if (res.ok && data.ok) {
        setTestResult(data.simulated
          ? {
              ok: true,
              simulated: true,
              message: `Simulated — no WhatsApp message was sent. ID: ${data.messageId}`,
            }
          : { ok: true, message: `Sent! Message ID: ${data.messageId}` })
      } else {
        setTestResult({ ok: false, message: data.error ?? "Failed to send" })
      }
    } catch {
      setTestResult({ ok: false, message: "Network error" })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Meta Embedded Signup — official WhatsApp Cloud API onboarding.
          Button is disabled until NEXT_PUBLIC_META_APP_ID / NEXT_PUBLIC_META_ES_CONFIG_ID
          are configured (Hein's Meta Tech-Provider setup, external to this repo). */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-5">
        <h2 className="font-semibold text-gray-900 text-sm mb-1">Official WhatsApp Cloud API</h2>
        <p className="text-xs text-gray-400 mb-3">
          Connect a WhatsApp Business Account via Meta&apos;s Embedded Signup — no manual token copying.
        </p>
        {waNumber ? (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm text-gray-900">
              <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0" />
              Connected · {waNumber} · {waProvider ?? "WA_CLOUD"}
            </span>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-50"
            >
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        ) : (
          <button
            onClick={handleConnectWhatsApp}
            disabled={!META_APP_ID || !META_ES_CONFIG_ID || esConnecting}
            className="flex items-center gap-2 px-4 py-2 rounded-md text-[#0e1117] text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: "#25D366" }}
          >
            <MessageCircle className="h-3.5 w-3.5" />
            {esConnecting ? "Connecting…" : "Connect WhatsApp (official)"}
          </button>
        )}
        {!waNumber && (!META_APP_ID || !META_ES_CONFIG_ID) && (
          <p className="text-[11px] text-gray-400 mt-2">
            Requires <code className="font-mono">NEXT_PUBLIC_META_APP_ID</code> and{" "}
            <code className="font-mono">NEXT_PUBLIC_META_ES_CONFIG_ID</code> to be configured.
          </p>
        )}
        {disconnectError && (
          <div className="mt-3 flex items-center gap-2 text-sm px-3 py-2 rounded-md bg-red-50 text-red-600">
            <XCircle className="h-4 w-4 flex-shrink-0" />
            {disconnectError}
          </div>
        )}
        {esResult && (
          <div className={`mt-3 flex items-center gap-2 text-sm px-3 py-2 rounded-md ${esResult.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
            {esResult.ok ? <CheckCircle className="h-4 w-4 flex-shrink-0" /> : <XCircle className="h-4 w-4 flex-shrink-0" />}
            {esResult.message}
          </div>
        )}
      </div>

      {/* Test message */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-5">
        <h2 className="font-semibold text-gray-900 text-sm mb-3">Test Connection</h2>
        <div className="flex gap-3">
          <input
            type="tel"
            value={testPhone}
            onChange={(e) => setTestPhone(e.target.value)}
            placeholder="27821234567 or 0821234567"
            className="flex-1 border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4338CA]"
          />
          <button
            onClick={handleTest}
            disabled={testing || !testPhone.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-md text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: "#4338CA" }}
          >
            <Send className="h-3.5 w-3.5" />
            {testing ? "Sending…" : "Send Test"}
          </button>
        </div>
        {testResult && (
          <div className={`mt-3 flex items-center gap-2 text-sm px-3 py-2 rounded-md ${testResult.simulated ? "bg-amber-50 text-amber-700" : testResult.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
            {testResult.simulated ? <Info className="h-4 w-4 flex-shrink-0" /> : testResult.ok ? <CheckCircle className="h-4 w-4 flex-shrink-0" /> : <XCircle className="h-4 w-4 flex-shrink-0" />}
            {testResult.message}
          </div>
        )}
      </div>
    </div>
  )
}
