// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readSource } from './setup/read-source'

describe('pet dragging follows pointer movement', () => {
  const hook = readSource('src/hooks/use-window-draggable.ts')
  const app = readSource('src/pet/app.tsx')

  it('captures the hitbox pointer and moves the window by each pointer delta', () => {
    expect(hook).toContain('setPointerCapture(event.pointerId)')
    expect(hook).toContain('event.clientX - last.x')
    expect(hook).toContain('event.clientY - last.y')
    expect(hook).toContain("invoke('move_pet_window'")
    expect(hook).not.toContain('startDragging()')
  })

  it('passes the complete pointer lifecycle from the hitbox to the drag hook', () => {
    expect(app).toContain('onHitboxPointerDown={draggable.onPointerDown}')
    expect(app).toContain('onHitboxPointerMove={draggable.onPointerMove}')
    expect(app).toContain('onHitboxPointerUp={draggable.onPointerUp}')
    expect(app).toContain('onHitboxPointerCancel={draggable.onPointerCancel}')
  })
})
