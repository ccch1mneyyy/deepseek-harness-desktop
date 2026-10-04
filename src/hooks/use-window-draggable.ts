import { invoke } from '@tauri-apps/api/core'
import { useRef, useState } from 'react'

type DragDirection = 'left' | 'right'

export interface UseWindowDraggableResult {
  dragging: boolean
  direction: DragDirection | undefined
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void
  onPointerUp: () => void
  onPointerCancel: () => void
}

const DRAG_START_THRESHOLD = 8
const DRAG_DIRECTION_THRESHOLD = 3

export function useWindowDraggable(): UseWindowDraggableResult {
  const activeRef = useRef(false)
  const engagedRef = useRef(false)
  const originRef = useRef<{ x: number, y: number } | undefined>(undefined)
  const lastRef = useRef<{ x: number, y: number } | undefined>(undefined)
  const pendingDeltaRef = useRef({ x: 0, y: 0 })
  const movingRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [direction, setDirection] = useState<DragDirection | undefined>(undefined)

  function endDrag(): void {
    activeRef.current = false
    engagedRef.current = false
    originRef.current = undefined
    lastRef.current = undefined
    pendingDeltaRef.current = { x: 0, y: 0 }
    setDragging(false)
    setDirection(undefined)
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0)
      return
    event.currentTarget.setPointerCapture(event.pointerId)
    activeRef.current = true
    engagedRef.current = false
    originRef.current = { x: event.clientX, y: event.clientY }
    lastRef.current = { x: event.clientX, y: event.clientY }
    setDirection(undefined)
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!activeRef.current)
      return
    const last = lastRef.current
    if (last === undefined)
      return
    const current = { x: event.clientX, y: event.clientY }
    const origin = originRef.current ?? current
    const scale = globalThis.devicePixelRatio || 1
    const dx = current.x - last.x
    const dy = current.y - last.y
    lastRef.current = current
    if (dx !== 0 || dy !== 0) {
      pendingDeltaRef.current.x += Math.round(dx * scale)
      pendingDeltaRef.current.y += Math.round(dy * scale)
    }
    if (!engagedRef.current) {
      if (Math.hypot(current.x - origin.x, current.y - origin.y) < DRAG_START_THRESHOLD)
        return
      engagedRef.current = true
      setDragging(true)
    }
    if (Math.abs(dx) >= DRAG_DIRECTION_THRESHOLD)
      setDirection(dx > 0 ? 'right' : 'left')
    flushMove()
  }

  function flushMove(): void {
    if (movingRef.current)
      return
    const delta = pendingDeltaRef.current
    if (delta.x === 0 && delta.y === 0)
      return
    pendingDeltaRef.current = { x: 0, y: 0 }
    movingRef.current = true
    void invoke('move_pet_window', { deltaX: delta.x, deltaY: delta.y }).catch(() => {}).finally(() => {
      movingRef.current = false
      flushMove()
    })
  }

  function handlePointerUp(): void {
    endDrag()
  }

  return {
    dragging,
    direction,
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerUp,
  }
}
