import type { PetPhysicsEvent, PetRef, PhysicsParams } from 'dsh-pet-component'
import type { DragSample, ThrowBounds, ThrowState } from './use-pet-physics.helpers'
import { useRafFn } from '@reause/core'
import { currentMonitor, getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window'
import { useEffect, useRef } from 'react'
import { useListen } from '@/hooks/use-listen'
import { reportPetIssue } from '../utils/log'
import { bodyBounds, estimateReleaseVelocity, stepThrow } from './use-pet-physics.helpers'

/** 轨迹最多留 64 个样本：估速只看最近 150ms，长拖不必无限增长。 */
const TRAIL_LIMIT = 64

/**
 * 宿主侧甩动：把「松手 → 请求甩出 → 飞行 → 落地 Q 弹」接在 dsh-pet-component 的协议上。
 *
 * 组件 0.2.3 起把甩动物理留给宿主（见组件 `docs/spec/pet-interactions.md` 的职责划分），
 * 桌宠宿主的舞台就是显示器工作区、宠物本体就是窗口，于是飞行 = 每帧 `setPosition`：
 *
 * - **轨迹来自窗口 `Moved`**：原生拖拽跑在系统模态循环里，webview 收不到 pointermove，
 *   窗口位移是唯一能看出「甩得多快」的信号；`device-mouse-button` 给的是 OS 侧的松开
 *   时刻（见 `use-window-draggable.ts`），两者拼出一次甩动；
 * - **增益只在 `onFling` 里施加**：松手时先用 `throwPower = 1` 判断「这一下要不要甩」，
 *   组件回吐的 `PetPhysicsEvent` 才带着合并后的 `physics`（prop > 配置 > 默认），速度的
 *   `throwPower` 放大因此只能在那里做 —— 默认值 1 时与组件参考实现完全等价；
 * - **单位是 CSS px**：重力/速度都按组件默认参数的语义（CSS px/s）算，写回窗口时乘
 *   `devicePixelRatio` 换成物理像素；Retina 上不去换算，观感速度会差一倍；
 * - 单宠物窗口没有宠物间碰撞，`physics.petCollision` 与 `pet.bounce` 不适用。
 */
export function usePetPhysics(pet: PetRef, kind: 'dsh' | 'codex' | undefined): (event: PetPhysicsEvent) => void {
  const trailRef = useRef<DragSample[]>([])
  const pressedRef = useRef(false)
  const flightRef = useRef<Flight | null>(null)
  // 飞行代号：起飞行要 await 显示器与窗口位置，期间可能被「抓取取消」或下一次甩动顶掉。
  const flightIdRef = useRef(0)
  const kindRef = useRef(kind)
  kindRef.current = kind
  // useRafFn 每渲染返回新对象，飞行循环统一走 ref，避免闭包抓到旧的 pause/resume。
  const rafRef = useRef<{ pause: () => void, resume: () => void } | null>(null)

  const raf = useRafFn(({ delta }) => {
    const flight = flightRef.current
    if (flight === null) {
      rafRef.current?.pause()
      return
    }

    const next = stepThrow(flight.state, delta / 1000, flight.bounds, flight.physics)
    flight.state = { x: next.x, y: next.y, vx: next.vx, vy: next.vy }
    // 窗口位置取整：亚像素位置在 Windows 上会被系统四舍五入，抖动比丢精度更显眼。
    void getCurrentWindow()
      .setPosition(new PhysicalPosition(
        Math.round((next.x - flight.originX) * flight.scale),
        Math.round((next.y - flight.originY) * flight.scale),
      ))
      .catch(() => {})

    // 落地 Q 弹复用组件的挤压动画；力度是撞击瞬间的下坠速度（积分前）。
    if (next.landed)
      pet.squash(next.impactSpeed)
    if (next.atRest)
      flightRef.current = null
  }, { immediate: false })
  rafRef.current = raf

  useEffect(() => {
    // keep:effect 原生拖拽期间 webview 收不到 pointermove，只能靠窗口 Moved 采轨迹
    let disposed = false
    let unlisten: (() => void) | undefined

    void getCurrentWindow()
      .onMoved((event) => {
        if (!pressedRef.current)
          return
        const scale = window.devicePixelRatio
        const samples = trailRef.current
        samples.push({ t: performance.now(), x: event.payload.x / scale, y: event.payload.y / scale })
        if (samples.length > TRAIL_LIMIT)
          samples.splice(0, samples.length - TRAIL_LIMIT)
      })
      .then((fn) => {
        if (disposed)
          fn()
        else
          unlisten = fn
      })
      .catch(error => reportPetIssue('fling-moved', error))

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useListen<MouseButtonState>('device-mouse-button', ({ payload }) => {
    if (payload.pressed) {
      // 抓取即落地刹车：组件自己会取消挤压动画，这里只要停下窗口飞行。
      pressedRef.current = true
      trailRef.current = []
      stopFlight()
      return
    }

    if (!pressedRef.current)
      return
    pressedRef.current = false

    const trail = trailRef.current
    trailRef.current = []
    const release = estimateReleaseVelocity(trail, performance.now(), 1)
    if (release !== null)
      pet.fling(release)
  })

  /** 终止飞行（含尚未起飞的请求）：抓取、下一次甩出、卸载都走这里。 */
  function stopFlight(): void {
    flightIdRef.current += 1
    if (flightRef.current === null)
      return
    flightRef.current = null
    rafRef.current?.pause()
  }

  return (event: PetPhysicsEvent): void => {
    const id = flightIdRef.current + 1
    flightIdRef.current = id
    flightRef.current = null
    rafRef.current?.pause()
    void startFlight(event, id)
  }

  /** 组件校验后的甩出请求：读出几何与屏幕工作区，把这次甩动变成一次飞行。 */
  async function startFlight(event: PetPhysicsEvent, id: number): Promise<void> {
    try {
      const [monitor, position] = await Promise.all([currentMonitor(), getCurrentWindow().outerPosition()])
      // 等待期间被下一次甩动或抓取顶掉：这次请求作废。
      if (monitor === null || id !== flightIdRef.current)
        return

      const scale = window.devicePixelRatio
      const area = monitor.workArea
      // 工作区与窗口位置都是物理像素，除 dpr 换成视口 px（= CSS px）后才能和组件几何对齐。
      const stage = {
        x: area.position.x / scale,
        y: area.position.y / scale,
        width: area.size.width / scale,
        height: area.size.height / scale,
      }
      const local = bodyBounds(event.geometry, stage.width, stage.height, kindRef.current === 'dsh')
      const origin = position.toLogical(scale)

      flightRef.current = {
        // 组件几何挂在本窗口的视口上：容器屏幕坐标 = 窗口逻辑位置 + 视口原点。
        state: {
          x: origin.x + event.geometry.x,
          y: origin.y + event.geometry.y,
          vx: event.vx * event.physics.throwPower,
          vy: event.vy * event.physics.throwPower,
        },
        physics: event.physics,
        bounds: {
          minX: stage.x + local.minX,
          minY: stage.y + local.minY,
          maxX: stage.x + local.maxX,
          maxY: stage.y + local.maxY,
        },
        originX: event.geometry.x,
        originY: event.geometry.y,
        scale,
      }
      rafRef.current?.resume()
    }
    catch (error) {
      reportPetIssue('fling', error)
    }
  }
}

/** 一次飞行的全部状态：位置/速度 + 参数快照 + 屏幕边界 + 窗口换算。 */
interface Flight {
  state: ThrowState
  physics: PhysicsParams
  bounds: ThrowBounds
  /** 容器（宠物）在窗口视口里的原点：窗口位置 = 飞行位置 - 原点。 */
  originX: number
  originY: number
  /** 起飞行时的 `devicePixelRatio`（= Tauri 缩放系数），每帧换算窗口位置用。 */
  scale: number
}

/** `device-mouse-button` 的事件载荷（对应 Rust 的 `MouseButtonState`）。 */
interface MouseButtonState {
  pressed: boolean
}
