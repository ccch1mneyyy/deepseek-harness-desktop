// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWindowDraggable } from './use-window-draggable'

interface MovedEvent { payload: { x: number, y: number } }
type MovedHandler = (event: MovedEvent) => void

/**
 * 本文件把 `useListen` 替换成同步登记表：拖拽收尾依赖后端设备流事件，而真实
 * `listen` 要走 Tauri IPC，在 jsdom 里无法投递。
 */
const deviceListeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>())

vi.mock('@/hooks/use-listen', () => ({
  useListen: (event: string, handler: (event: { payload: unknown }) => void) => {
    deviceListeners.set(event, handler)
  },
}))

const windowMocks = vi.hoisted(() => ({
  startDragging: vi.fn<() => Promise<void>>(),
  onMoved: vi.fn<(handler: MovedHandler) => Promise<() => void>>(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowMocks,
}))

const invokeMock = vi.hoisted(() => vi.fn<(command: string) => Promise<void>>())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

/** 与 `use-window-draggable.ts` 的 `DRAG_SESSION_TIMEOUT` 一致（模块私有，不导出）。 */
const DRAG_SESSION_TIMEOUT = 1500

let movedHandlers: MovedHandler[] = []

/** 按下左键：webview 收到 pointerdown 后才会开启拖拽会话。 */
function pressPointer(): void {
  const event = new Event('pointerdown', { bubbles: true })
  Object.defineProperty(event, 'button', { value: 0 })
  act(() => {
    window.dispatchEvent(event)
  })
}

/** 原生拖拽期间窗口移动（Windows 上拖拽会话吞掉按钮事件，只剩 Moved）。 */
function moveWindow(x: number, y: number): void {
  act(() => {
    for (const handler of [...movedHandlers])
      handler({ payload: { x, y } })
  })
}

/** 后端设备流的左键状态事件。 */
function pressMouse(pressed: boolean): void {
  const handler = deviceListeners.get('device-mouse-button')
  if (handler === undefined)
    throw new Error('未订阅 device-mouse-button：松开判断退回 1.5s 停歇兜底（Bug 复现）')
  act(() => {
    handler({ payload: { pressed } })
  })
}

/** 按下并拖过 `DRAG_START_THRESHOLD`，进入拖拽态。 */
function startDraggingSession(): void {
  pressPointer()
  moveWindow(100, 100)
  moveWindow(120, 100)
}

beforeEach(() => {
  vi.useFakeTimers()
  movedHandlers = []
  deviceListeners.clear()
  windowMocks.startDragging.mockResolvedValue(undefined)
  windowMocks.onMoved.mockImplementation(async (handler) => {
    movedHandlers.push(handler)
    return () => {
      movedHandlers = movedHandlers.filter(item => item !== handler)
    }
  })
  invokeMock.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useWindowDraggable', () => {
  it('松开左键时立即结束拖拽，不等 Moved 停歇超时', () => {
    const { result } = renderHook(() => useWindowDraggable())

    startDraggingSession()
    expect(result.current.dragging).toBe(true)
    expect(result.current.direction).toBe('right')

    pressMouse(false)

    expect(result.current.dragging).toBe(false)
    expect(result.current.direction).toBeUndefined()
  })

  it('左键仍按下时不结束拖拽', () => {
    const { result } = renderHook(() => useWindowDraggable())

    startDraggingSession()
    pressMouse(true)

    expect(result.current.dragging).toBe(true)
  })

  it('设备流失联时仍由 Moved 停歇兜底结束', () => {
    const { result } = renderHook(() => useWindowDraggable())

    startDraggingSession()
    act(() => {
      vi.advanceTimersByTime(DRAG_SESSION_TIMEOUT)
    })

    expect(result.current.dragging).toBe(false)
  })

  it('松开后再次按下并移动可重新进入拖拽', () => {
    const { result } = renderHook(() => useWindowDraggable())

    startDraggingSession()
    pressMouse(false)
    expect(result.current.dragging).toBe(false)

    pressPointer()
    moveWindow(200, 200)
    moveWindow(230, 200)

    expect(result.current.dragging).toBe(true)
  })

  it('挂载时拉起后端鼠标设备流', () => {
    renderHook(() => useWindowDraggable())

    expect(invokeMock).toHaveBeenCalledWith('start_pet_mouse_stream')
  })
})
