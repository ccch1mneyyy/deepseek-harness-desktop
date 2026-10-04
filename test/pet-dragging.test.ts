// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readSource } from './setup/read-source'

describe('pet dragging follows the pointer (upstream spring feel)', () => {
  const hook = readSource('src/hooks/use-window-draggable.ts')
  const app = readSource('src/pet/app.tsx')
  const cursorEvents = readSource('src/hooks/use-omit-ignore-cursor-events.ts')

  // 只守住跨文件的接线契约；弹簧积分、门槛、收尾等行为由
  // `src/hooks/use-window-draggable.test.ts` 的 jsdom 用例覆盖。
  it('drives the window from the backend cursor stream instead of DOM deltas', () => {
    expect(hook).toContain('\'device-mouse-move\'')
    expect(hook).toContain('\'device-mouse-button\'')
    expect(hook).toContain('.setPosition(')
    // 文档注释里会提到原生 `startDragging()` 作为对照，这里断言的是不再调用它。
    expect(hook).not.toContain('.startDragging(')
  })

  it('uses the upstream playground spring constants for the follow motion', () => {
    expect(hook).toContain('const FOLLOW_STIFFNESS = 200')
    expect(hook).toContain('const FOLLOW_DAMPING = 30')
    expect(hook).toContain('const DRAG_START_THRESHOLD = 5')
    expect(hook).toContain('const DRAG_DIRECTION_THRESHOLD = 3')
  })

  it('passes the pointer lifecycle from the hitbox to the drag hook', () => {
    expect(app).toContain('onHitboxPointerDown={draggable.onPointerDown}')
    expect(app).toContain('onHitboxPointerUp={draggable.onPointerUp}')
    // 跟手不依赖 DOM pointermove（窗口移动会让 clientX 反向变化），也不认
    // pointercancel（穿透态切换会取消指针会话）。
    expect(app).not.toContain('onHitboxPointerMove=')
    expect(app).not.toContain('onHitboxPointerCancel=')
  })

  it('keeps the window interactive while dragging so the release is delivered', () => {
    expect(app).toContain('useOmitIgnoreCursorEvents(hitboxRef, draggable.dragging)')
    expect(cursorEvents).toContain('dragging = false')
  })
})
