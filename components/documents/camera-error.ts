/**
 * What to tell a person whose camera would not open, from the error
 * getUserMedia raised. Plain words and what to do next: never the browser's own
 * message (the audit saw "Camera unavailable — No camera found" with nothing to
 * act on; Fair Score audit 2026-10-16).
 */
export type CameraFailure = "blocked" | "no_camera" | "busy" | "insecure" | "other"

export function cameraFailure(error: unknown): CameraFailure {
  const name = error instanceof Error || (typeof error === "object" && error !== null && "name" in error)
    ? String((error as { name?: unknown }).name)
    : ""
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "blocked"
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "no_camera"
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy"
  if (name === "SecurityError" || name === "TypeError") return "insecure"
  return "other"
}

export const CAMERA_FAILURE_MESSAGES: Record<CameraFailure, string> = {
  blocked: "Camera access is blocked for this site. Allow the camera in your browser settings and try again, or continue on your phone.",
  no_camera: "We couldn't find a camera on this device. Continue on your phone instead.",
  busy: "Your camera is being used by another app. Close that app and try again, or continue on your phone.",
  insecure: "This browser won't open the camera on this page. Continue on your phone instead.",
  other: "We couldn't start your camera. Try again, or continue on your phone.",
}
