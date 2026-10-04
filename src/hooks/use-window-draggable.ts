import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTimeoutFn } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { useListen } from '@/hooks/use-listen'

/** 拖拽的水平方向。 */
type DragDirection = 'left' | 'right'

/**
 * `device-mouse-button` 事件载荷：全局鼠标左键是否按下。
 * 与后端 `src-tauri/src/desktop/pet_mouse.rs` 的 `MouseButtonState` 一一对应。
 */
interface MouseButtonState {
  pressed: boolean
}

export interface UseWindowDraggableResult {
  /** 拖拽会话进行中（按下后位移超过阈值才算，结束或兜底收尾后为 false）。 */
  dragging: boolean
  /** 当前拖拽方向；未拖拽、位移不足或拖拽停顿时为 undefined。 */
  direction: DragDirection | undefined
  /** 命中箱 pointerdown（`<Pet>` 的 `onHitboxPointerDown`）：开启会话并捕获指针。 */
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  /** 命中箱 pointermove（`<Pet>` 的 `onHitboxPointerMove`）：按指针增量移动窗口。 */
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  /** 命中箱 pointerup / pointercancel：结束会话。 */
  onPointerUp: () => void
  onPointerCancel: () => void
}

/** 判定「真正开始拖拽」的累计位移阈值（逻辑像素）：未达阈值按单击处理。 */
const DRAG_START_THRESHOLD = 8
/** 判定方向的水平位移阈值（逻辑像素），滤除拖拽起始时刻的抖动。 */
const DRAG_DIRECTION_THRESHOLD = 3
/** 方向停摆阈值：超过此时长没有新的 pointermove，方向归零（宠物回到 idle/会话动画）。 */
const DRAG_DIRECTION_IDLE_TIMEOUT = 350
/** 会话兜底阈值：超过此时长没有新的 pointermove，且左键状态未知/已松开时收尾拖拽。 */
const DRAG_SESSION_TIMEOUT = 1500

/**
 * 桌宠窗口拖拽（桌宠窗口在用）：跟随指针增量移动窗口，供上层切换 moving-left/right。
 *
 * # 为什么是「跟随指针」而不是原生 `startDragging()`
 *
 * 原生拖拽把移动交给系统模态循环：窗口位置由系统直接更新，指针与窗口之间没有任何插值，
 * 手感是「窗口咬着光标跳」。`dsh-pet-component` README「拖拽交互集成」里的官方用法相反：
 * 组件不接管指针会话，宿主在 `onHitboxPointerDown` 里自行 `setPointerCapture`、在
 * `onHitboxPointerMove` 里采样增量并移动窗口 —— 这条「宿主驱动」的路径才与网页版一致。
 * 因此这里与官方用法对齐：命中箱按下时捕获指针，之后每个 pointermove 都把
 * `clientX/clientY` 增量交给 `move_pet_window`（后端按物理像素累加并夹回可见显示器）。
 *
 * # 为什么用指针增量，而不是复用窗口 `Moved` 事件
 *
 * 指针增量是拖拽的「输入」，窗口 `Moved` 是「输出」：拿输出反推方向会晚一帧；而且原生
 * 拖拽期间 webview 收不到 pointermove，只能靠 Moved 事件停歇猜结束。代价是
 * `move_pet_window` 每次调用都要读窗口位置/尺寸、枚举显示器、写回持久化位置，不适合
 * 一个 pointermove 一次 IPC：这里在本地累积增量，同一时刻只允许一个 IPC 在途
 * （`movingRef`），返回后再冲刷下一批。指针增量是逻辑像素、窗口位置是物理像素，
 * 因此按 `devicePixelRatio` 换算。
 *
 * # 结束时刻：指针事件为主，后端设备流兜底
 *
 * 指针被命中箱捕获后，`pointerup` / `pointercancel` 一般可靠到达，拖拽即时收尾。
 * 若指针事件流异常中断（丢掉 pointerup 会让拖拽态永久粘住、宠物一直播拖动动画），
 * 还有两级兜底：后端全局鼠标流用 `device-mouse-button` 上报 OS 侧左键状态，松开即收尾；
 * 以及 pointermove 停歇超过 `DRAG_SESSION_TIMEOUT` 时收尾 —— 但仅在左键状态未知或
 * 已松开时才收尾，设备流仍报告按下（拖拽中长时间静止）时只重新计时，
 * 避免「按住不动再拖」被误判为结束。
 */
export function useWindowDraggable(): UseWindowDraggableResult {
  const activeRef = useRef(false)
  const engagedRef = useRef(false)
  const originRef = useRef<{ x: number, y: number } | undefined>(undefined)
  const lastRef = useRef<{ x: number, y: number } | undefined>(undefined)
  const pendingDeltaRef = useRef({ x: 0, y: 0 })
  const movingRef = useRef(false)
  /**
   * 后端设备流最近一次上报的左键状态。`true` = 确认仍按下（拖拽中长时间静止不算结束）；
   * `undefined` = 本次会话没有收到过上报（设备流失联，停歇兜底按「未知」收尾）。
   * 不在 pointerdown 里重置：按下与设备流上报没有固定先后，清掉新会话的 `true` 会让
   * 「按住不动再拖」被停歇阈值误杀；改为在会话结束时重置。
   */
  const pressedRef = useRef<boolean | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const [direction, setDirection] = useState<DragDirection | undefined>(undefined)

  // reause 的 `useTimeoutFn` 缺省在挂载时就开始计时，这里必须 `immediate: false`：
  // 只有拖拽中的 pointermove 才重新 `start()`（等价于「重置计时」）。回调始终读取最新闭包，
  // 且只操作 ref 与 setState，因此不需要额外的 clearTimeout 记账。
  const { start: armDirectionTimer, stop: stopDirectionTimer } = useTimeoutFn(
    parkDirection,
    DRAG_DIRECTION_IDLE_TIMEOUT,
    { immediate: false },
  )
  const { start: armSessionTimer, stop: stopSessionTimer } = useTimeoutFn(
    handleSessionTimeout,
    DRAG_SESSION_TIMEOUT,
    { immediate: false },
  )

  /** 暂停移动：方向归零（宠物回到 idle/会话动画），但拖拽会话保持存活。 */
  function parkDirection(): void {
    setDirection(undefined)
  }

  /** 拖拽会话兜底：pointermove 停歇超过 `DRAG_SESSION_TIMEOUT` 时触发（见 hook 文档）。 */
  function handleSessionTimeout(): void {
    if (activeRef.current && pressedRef.current === true) {
      armSessionTimer()
      return
    }
    endDrag()
  }

  function endDrag(): void {
    activeRef.current = false
    engagedRef.current = false
    originRef.current = undefined
    lastRef.current = undefined
    pendingDeltaRef.current = { x: 0, y: 0 }
    pressedRef.current = undefined
    stopDirectionTimer()
    stopSessionTimer()
    setDragging(false)
    setDirection(undefined)
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0)
      return
    // 捕获指针：命中箱之外（宠物透明像素、窗口边界外）的 pointermove 依然回到命中箱，
    // 因此不需要 window 级监听，也不会因为 `<Pet>` 在提交阶段才挂上命中箱而漏绑。
    // 不调用 preventDefault：取消 pointerdown 会抑制兼容鼠标事件，文本选择/触屏滚动
    // 已由样式（select-none / touch-none）防护。
    event.currentTarget.setPointerCapture(event.pointerId)
    activeRef.current = true
    engagedRef.current = false
    const origin = { x: event.clientX, y: event.clientY }
    originRef.current = origin
    lastRef.current = origin
    pendingDeltaRef.current = { x: 0, y: 0 }
    setDirection(undefined)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!activeRef.current)
      return
    const last = lastRef.current
    if (last === undefined)
      return
    const current = { x: event.clientX, y: event.clientY }
    const origin = originRef.current ?? current
    const dx = current.x - last.x
    const dy = current.y - last.y
    lastRef.current = current
    // 事件流仍在推进：重置「方向停摆」与「会话兜底」两级计时。
    armDirectionTimer()
    armSessionTimer()
    if (dx !== 0 || dy !== 0) {
      // 指针增量是逻辑像素，窗口位置是物理像素（后端 `move_pet_window` 按物理像素累加）。
      const scale = globalThis.devicePixelRatio || 1
      pendingDeltaRef.current.x += Math.round(dx * scale)
      pendingDeltaRef.current.y += Math.round(dy * scale)
    }
    if (!engagedRef.current) {
      // 未达拖拽阈值：单击/轻微抖动不算拖拽，也不移动窗口（位移基准保持不动，
      // 越过阈值时一次性把这段累计位移补上，避免窗口落后指针一个阈值）。
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
    // 先清零再发：窗口可能已被夹在屏幕边缘（后端 `clamp_window_position` 丢弃越界增量），
    // 已消费的增量不再补发，反向拖动时不会先「滑回」一段。
    pendingDeltaRef.current = { x: 0, y: 0 }
    movingRef.current = true
    void invoke('move_pet_window', { deltaX: delta.x, deltaY: delta.y }).catch(() => {}).finally(() => {
      movingRef.current = false
      flushMove()
    })
  }

  // 只认松开：拖拽会话由 onPointerDown 开启，后端设备流补的是 OS 侧的结束时刻
  // （指针事件流失联导致丢 pointerup 时，靠它保证拖拽态不粘住）。
  useListen<MouseButtonState>('device-mouse-button', ({ payload }) => {
    if (payload.pressed) {
      pressedRef.current = true
      return
    }
    endDrag()
  })

  // keep:effect 拉起后端鼠标设备流（左键状态是丢 pointerup 时的兜底信号）；命令幂等，
  // 渲染期调用会在每次重渲染重复发起 IPC。
  useEffect(() => {
    void invoke('start_pet_mouse_stream').catch(() => {})
  }, [])

  return {
    dragging,
    direction,
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  }
}
