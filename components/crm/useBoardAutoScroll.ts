"use client"

import { useCallback, useEffect, useRef, useState } from "react"

// Edge auto-scroll for a horizontally scrolling kanban board.
//
// Exists because HTML5 drag-and-drop does NOT scroll a container for you. While
// every column fitted on screen this was nobody's problem; once the board
// scrolls sideways, a stage the user cannot see is a stage they cannot drop on,
// and there is no gesture that scrolls mid-drag either — the card is holding
// the pointer. Without this, "move a lead to Lost" becomes impossible whenever
// Lost is off-screen, which is most of the time.
//
// The velocity rule is a pure function so it can be tested without a drag: a
// browser drag cannot be driven from vitest, so if the arithmetic lived inside
// the event handler it would be verified by hand exactly once, today.

/** Pointer-to-edge distance at which scrolling begins, px. */
export const EDGE_ZONE_PX = 72
/** Scroll step at the very edge, px per animation frame. */
export const MAX_STEP_PX = 18

/**
 * Horizontal scroll step for a pointer at `clientX` over a board spanning
 * `left`..`right`. Negative scrolls left, positive right, 0 holds still.
 *
 * Ramped rather than constant: a fixed step is either too slow to cross a wide
 * board or too fast to stop on the column you wanted. The step grows from 0 at
 * the edge of the zone to MAX_STEP_PX at the boundary itself, so the user
 * controls speed by how far they push.
 *
 * A pointer OUTSIDE the board (clientX beyond either edge — reachable, the drag
 * continues past the container) saturates rather than accelerating without
 * limit, which is why the ratio is clamped and not just scaled.
 */
export function edgeScrollStep(clientX: number, left: number, right: number): number {
  const fromLeft = clientX - left
  const fromRight = right - clientX

  // Degenerate/zero-width rect: no meaningful edges, so never scroll. Also
  // guards a board narrower than two edge zones, where both branches would
  // otherwise be live at once and the left one would silently always win.
  if (right - left < EDGE_ZONE_PX * 2) return 0

  if (fromLeft < EDGE_ZONE_PX) {
    const ratio = Math.min(1, (EDGE_ZONE_PX - fromLeft) / EDGE_ZONE_PX)
    return -Math.ceil(ratio * MAX_STEP_PX)
  }
  if (fromRight < EDGE_ZONE_PX) {
    const ratio = Math.min(1, (EDGE_ZONE_PX - fromRight) / EDGE_ZONE_PX)
    return Math.ceil(ratio * MAX_STEP_PX)
  }
  return 0
}

/** Whether each end of the board has content scrolled out of view. Drives the
 *  edge fades — the cue that there is more board than the viewport shows. */
export type BoardEdges = { left: boolean; right: boolean }

/**
 * Wires edge auto-scroll and overflow detection to a scroll container.
 *
 * Returns the ref to attach, the drag handlers, and which edges are currently
 * overflowing. `onDragOver` must be on the CONTAINER: the columns' own
 * dragover handlers do not stop propagation, so it sees every move.
 */
export function useBoardAutoScroll() {
  // A CALLBACK ref, not a ref object, and the element never leaves this hook.
  // Returning a ref object taints the whole returned value for
  // react-hooks/refs: the compiler then reads every `board.onDragOver` at the
  // call site as a ref access during render and fails the lint. A callback ref
  // is an ordinary function, so the caller only ever handles plain values.
  const element = useRef<HTMLDivElement | null>(null)
  const scroll = useRef<{ step: number; frame: number | null }>({ step: 0, frame: null })
  const [edges, setEdges] = useState<BoardEdges>({ left: false, right: false })

  // 4px, not 0: scrollLeft is fractional under browser zoom and on HiDPI, so an
  // exact comparison leaves a fade stuck on at a hard end of travel.
  const syncEdges = useCallback(() => {
    const el = element.current
    if (!el) return
    const left = el.scrollLeft > 4
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
    // Return the SAME object when nothing changed so React bails out of the
    // re-render. This runs on every scroll event and on every auto-scroll
    // frame, and React's onScroll also fires for the columns' own VERTICAL
    // scrolling — a fresh object each time would re-render all eight columns
    // continuously while a user scrolls one column.
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
  }, [])

  const stop = useCallback(() => {
    if (scroll.current.frame !== null) cancelAnimationFrame(scroll.current.frame)
    scroll.current = { step: 0, frame: null }
  }, [])

  // The frame loop is a local recursive function rather than a useCallback that
  // schedules itself: a self-referencing useCallback sits in its own dependency
  // array and is read before it is declared.
  const start = useCallback(() => {
    const step = () => {
      const el = element.current
      if (!el || scroll.current.step === 0) {
        stop()
        return
      }
      el.scrollLeft += scroll.current.step
      syncEdges()
      scroll.current.frame = requestAnimationFrame(step)
    }
    scroll.current.frame = requestAnimationFrame(step)
  }, [stop, syncEdges])

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      const el = element.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      scroll.current.step = edgeScrollStep(e.clientX, rect.left, rect.right)
      if (scroll.current.step === 0) stop()
      else if (scroll.current.frame === null) start()
    },
    [start, stop]
  )

  const observer = useRef<ResizeObserver | null>(null)

  const setBoard = useCallback(
    (el: HTMLDivElement | null) => {
      element.current = el
      observer.current?.disconnect()
      observer.current = null
      if (!el || typeof ResizeObserver === "undefined") return
      // Re-measure on resize: collapsing the sidebar or rotating a phone
      // changes whether the board overflows, and a fade that only reflects the
      // width at mount is wrong from then on.
      observer.current = new ResizeObserver(syncEdges)
      observer.current.observe(el)
      syncEdges()
    },
    [syncEdges]
  )

  // Stopping is bound to `drop` and `dragend`, NOT `dragleave`: dragleave fires
  // every time the pointer crosses from the container into one of its own
  // children, so it would kill the scroll the instant it started. `dragend`
  // fires on the dragged card and bubbles here, and it fires even when the drag
  // is ABANDONED (Escape, or a drop on nothing) — which is the case that would
  // otherwise leave the board scrolling forever.
  useEffect(() => {
    return () => {
      stop()
      observer.current?.disconnect()
    }
  }, [stop])

  return { setBoard, edges, onDragOver, onScroll: syncEdges, onDrop: stop, onDragEnd: stop }
}
