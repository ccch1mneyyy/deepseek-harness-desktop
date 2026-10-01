import type { Browser, CDPSession, Page } from 'playwright'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const patch = readFileSync('src-tauri/src/service/patch/mobile_sidebar.rs', 'utf8')
function value(name: string): string {
  const raw = patch.match(new RegExp(`const ${name}: &str =\\s*r#"([\\s\\S]*?)"#;`))
  if (raw)
    return raw[1]!
  const escaped = patch.match(new RegExp(`const ${name}: &str =\\s*("(?:[^"\\\\]|\\\\.)*");`))
  if (!escaped)
    throw new Error(`Missing Rust constant ${name}`)
  return JSON.parse(escaped[1]!)
}
const original = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-layout/client'), 'utf8').replaceAll('\t', '    ')
let source = original
for (const name of ['FRAME', 'COLLAPSED', 'SIDEBAR', 'MEMO', 'STYLE', 'ATTR', 'COLUMN', 'CENTER', 'MAIN', 'CHILDREN']) {
  const anchor = value(name)
  expect(source.split(anchor).length - 1, `真实上游 ${name} 必须唯一匹配`).toBe(1)
  source = source.replace(anchor, name === 'FRAME' ? value('HOOK') + anchor : value(`${name}_PATCHED`))
}
source = source.replace('exports.LayoutController = LayoutController;', 'exports.AppFrame = AppFrame; exports.createLayoutStore = createLayoutStore; exports.LayoutController = LayoutController;')
function cjs(name: string, entry: string): string {
  const resolver = createRequire(require.resolve('react-dom/package.json'))
  const script = readFileSync(join(dirname(resolver.resolve(`${name}/package.json`)), 'cjs', entry), 'utf8')
  return `modules[${JSON.stringify(name)}] = (() => { const exports = {}; const module = { exports }; ${script}; return module.exports; })();`
}
const runtime = `const modules = {}; const require = name => modules[name]; const process = {env:{NODE_ENV:'production'}};
${cjs('react', 'react.production.js')}
${cjs('scheduler', 'scheduler.production.js')}
${cjs('react-dom', 'react-dom.production.js')}
${cjs('react-dom', 'react-dom-client.production.js').replace('modules["react-dom"] =', 'modules["react-dom/client"] =')}`

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
})

async function render(mobile = true, width = 390, reducedMotion = false, patched = true): Promise<{ page: Page, cdp: CDPSession }> {
  const page = await browser.newPage({ isMobile: mobile, hasTouch: mobile, viewport: { width, height: 844 }, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push(message.text())
  })
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%;--dsw-alias-bg-base:white;--dsw-specific-sidebar-fill:#eee}#scroll{height:100%;overflow:auto}#horizontal{width:180px;overflow-x:auto}#horizontal>div{width:900px}</style><div id="root"></div>')
  await page.addScriptTag({ content: `(() => { ${runtime}
modules['react/jsx-runtime'] = (() => { const exports = {}; const module = {exports}; ${readFileSync(join(dirname(require.resolve('react/package.json')), 'cjs/react-jsx-runtime.production.js'), 'utf8')}; return module.exports; })();
modules['@deepseek-ai/dsh-client-store'] = {defineStore: spec => spec};
window.__ModuleLoader__ = { load: ({factory}) => { window.layout = factory(require); } };
${patched ? source : original.replace('exports.LayoutController = LayoutController;', 'exports.AppFrame = AppFrame; exports.createLayoutStore = createLayoutStore; exports.LayoutController = LayoutController;')}
const React = modules.react; const jsx = modules['react/jsx-runtime'].jsx;
const spec = window.layout.createLayoutStore(); let state = spec.init(); const listeners = new Set();
const actions = Object.fromEntries(Object.entries(spec.actions).map(([name, run]) => [name, (...args) => { const next = structuredClone(state); run(next, ...args); state = next; listeners.forEach(listener => listener()); }]));
const useStore = selector => React.useSyncExternalStore(listener => {listeners.add(listener); return () => listeners.delete(listener);}, () => selector(state));
const renderSlot = (name, props) => name === 'sidebar' ? jsx('nav', {'data-slot':'sidebar', 'data-collapsed':props.collapsed, children:jsx('button',{id:'session',children:'Session'})}) : name === 'main' ? jsx('div',{id:'scroll',children:jsx('div',{style:{height:2000},children:[jsx('div',{id:'horizontal',children:jsx('div',{children:'horizontal scroll'})}),jsx('textarea',{id:'draft'}),jsx('button',{id:'content-button',onClick:()=>window.clicks++,children:'content'})]})}) : null;
window.clicks = 0; window.actions = actions; window.state = () => state;
window.reactRoot = modules['react-dom/client'].createRoot(document.getElementById('root'));
window.reactRoot.render(jsx(window.layout.AppFrame,{useStore,useSessions:selector=>selector({byId:{}}),usePanelInfo:selector=>selector({activePanelId:null}),actions,renderSlot,t:key=>key}));
})();` })
  await page.waitForFunction(() => document.querySelector('#scroll') !== null)
  expect(errors, '真实 AppFrame 无运行时错误').toEqual([])
  const cdp = await page.context().newCDPSession(page)
  return { page, cdp }
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', x = 180, y = 350, timestamp?: number): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, timestamp, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1 }] })
}
async function fling(cdp: CDPSession, from: number, to: number): Promise<void> {
  const timestamp = Date.now() / 1000
  await touch(cdp, 'touchStart', from, 350, timestamp)
  await touch(cdp, 'touchMove', to, 350, timestamp + 0.02)
  await touch(cdp, 'touchEnd', to, 350, timestamp + 0.025)
}
async function offset(page: Page): Promise<number> {
  return page.locator('#scroll').evaluate(element => Math.round(element.getBoundingClientRect().left))
}
async function opened(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { state: () => { layoutInfo: { narrowExpanded: boolean } } }).state().layoutInfo.narrowExpanded)
}

describe('native mobile sidebar', () => {
  it('exposes the upstream mobile rail that this patch replaces', async () => {
    const { page } = await render(true, 390, false, false)
    try {
      expect(await offset(page)).toBe(56)
      expect(await page.locator('#scroll').evaluate(element => element.getBoundingClientRect().width)).toBe(334)
    }
    finally { await page.close() }
  })

  it('finishes native swipes that start on the hamburger button', async () => {
    const { page, cdp } = await render()
    try {
      await touch(cdp, 'touchStart', 32, 32)
      await touch(cdp, 'touchMove', 232, 32)
      await expect.poll(() => offset(page)).toBe(200)
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 180)))
      await touch(cdp, 'touchEnd')
      await expect.poll(() => opened(page)).toBe(true)
      await expect.poll(() => offset(page)).toBe(320)
    }
    finally { await page.close() }
  })

  it('keeps offscreen chat controls out of keyboard focus while open', async () => {
    const { page } = await render()
    try {
      await page.locator('[data-dsh-sidebar-toggle]').click()
      await expect.poll(() => opened(page)).toBe(true)
      await page.locator('#draft').evaluate(element => (element as HTMLTextAreaElement).focus())
      expect(await page.locator('#draft').evaluate(element => document.activeElement === element)).toBe(false)
      await page.locator('#session').focus()
      await page.keyboard.press('Tab')
      expect(await page.locator('#draft').evaluate(element => document.activeElement === element)).toBe(false)
    }
    finally { await page.close() }
  })

  it('does not mistake a held short drag or a tap for a fling', async () => {
    const { page, cdp } = await render()
    try {
      await touch(cdp, 'touchStart', 80)
      await touch(cdp, 'touchMove', 125)
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 180)))
      await touch(cdp, 'touchEnd')
      await expect.poll(() => offset(page)).toBe(0)
      expect(await opened(page)).toBe(false)
      await touch(cdp, 'touchStart', 80)
      await touch(cdp, 'touchEnd')
      expect(await opened(page)).toBe(false)
    }
    finally { await page.close() }
  })

  it('prevents post-swipe ghost clicks, respects reduced motion and cancels on resize', async () => {
    const { page, cdp } = await render(true, 390, true)
    try {
      await fling(cdp, 80, 125)
      await expect.poll(() => opened(page)).toBe(true)
      expect(await page.locator('[data-dsh-center-column]').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
      await page.locator('[data-dsh-sidebar-shade]').evaluate(element => (element as HTMLButtonElement).click())
      expect(await opened(page), '手势后的兼容 click 不得立即关掉侧栏').toBe(true)
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 410)))
      await page.locator('[data-dsh-sidebar-shade]').click({ position: { x: 5, y: 350 } })
      await touch(cdp, 'touchStart', 40)
      await touch(cdp, 'touchMove', 150)
      await expect.poll(() => offset(page)).toBe(110)
      await page.setViewportSize({ width: 1200, height: 844 })
      await touch(cdp, 'touchCancel')
      await expect.poll(() => page.locator('[data-dsh-mobile-sidebar]').count()).toBe(0)
      expect(await offset(page)).toBe(280)
    }
    finally { await page.close() }
  })

  it('leaves right-panel layout ownership unchanged and cleans up on unmount', async () => {
    const { page } = await render()
    try {
      await page.evaluate(() => (window as unknown as { actions: { openRightbar: (track: boolean, fullscreen: boolean) => void } }).actions.openRightbar(true, false))
      await expect.poll(() => page.locator('[data-dsh-mobile-sidebar]').count()).toBe(0)
      await page.evaluate(() => (window as unknown as { actions: { closeRightbar: () => void } }).actions.closeRightbar())
      await expect.poll(() => page.locator('[data-dsh-mobile-sidebar]').count()).toBe(1)
      await page.locator('[data-dsh-sidebar-toggle]').click()
      await expect.poll(() => opened(page)).toBe(true)
      await page.evaluate(() => (window as unknown as { reactRoot: { unmount: () => void } }).reactRoot.unmount())
      await page.keyboard.press('Escape')
      expect(await opened(page), '卸载后不再响应原生事件').toBe(true)
      expect(await page.locator('[data-dsh-sidebar-shade]').count()).toBe(0)
    }
    finally { await page.close() }
  })

  it('keeps the chat full width and follows distance before release', async () => {
    const { page, cdp } = await render()
    try {
      expect(await offset(page), '收起时没有 56px 图标轨道').toBe(0)
      expect(await page.locator('#scroll').evaluate(element => element.getBoundingClientRect().width)).toBe(390)
      await touch(cdp, 'touchStart', 40)
      await touch(cdp, 'touchMove', 160)
      await expect.poll(() => offset(page)).toBe(120)
      expect(await opened(page), '拖动过程只投影位置，不提前提交布局状态').toBe(false)
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 180)))
      await touch(cdp, 'touchEnd')
      await expect.poll(() => offset(page)).toBe(0)
      await touch(cdp, 'touchStart', 40)
      await touch(cdp, 'touchMove', 230)
      await expect.poll(() => offset(page)).toBe(190)
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 180)))
      await touch(cdp, 'touchEnd')
      await expect.poll(() => opened(page)).toBe(true)
      await expect.poll(() => offset(page)).toBe(320)
      expect(await page.locator('[data-slot="sidebar"]').getAttribute('data-collapsed')).toBe('false')
    }
    finally { await page.close() }
  })

  it('opens with a quick short fling and closes with a left fling', async () => {
    const { page, cdp } = await render()
    try {
      await fling(cdp, 80, 125)
      await expect.poll(() => opened(page)).toBe(true)
      await expect.poll(() => offset(page)).toBe(320)
      await fling(cdp, 250, 205)
      await expect.poll(() => opened(page)).toBe(false)
      await expect.poll(() => offset(page)).toBe(0)
    }
    finally { await page.close() }
  })

  it('preserves native vertical conversation scrolling', async () => {
    const { page, cdp } = await render()
    try {
      await touch(cdp, 'touchStart', 180, 500)
      await touch(cdp, 'touchMove', 185, 300)
      await touch(cdp, 'touchEnd')
      await expect.poll(() => page.locator('#scroll').evaluate(element => element.scrollTop), { message: '纵向手势仍滚动聊天内容' }).toBeGreaterThan(0)
      expect(await opened(page)).toBe(false)
    }
    finally { await page.close() }
  })

  it('preserves native horizontal scrolling in both directions without opening the sidebar', async () => {
    const { page, cdp } = await render()
    try {
      await page.locator('#horizontal').evaluate((element) => {
        element.scrollLeft = 100
      })
      expect(await page.evaluate(() => document.elementFromPoint(80, 9)?.closest('#horizontal')?.id), '原生触摸命中横向滚动区域').toBe('horizontal')
      await touch(cdp, 'touchStart', 80, 9)
      await touch(cdp, 'touchMove', 160, 9)
      await touch(cdp, 'touchEnd')
      await expect.poll(() => page.locator('#horizontal').evaluate(element => element.scrollLeft), { message: '向右滑动交还横向滚动容器' }).toBeLessThan(100)
      expect(await opened(page)).toBe(false)
    }
    finally { await page.close() }
    const next = await render()
    try {
      await touch(next.cdp, 'touchStart', 160, 9)
      await touch(next.cdp, 'touchMove', 40, 9)
      await touch(next.cdp, 'touchEnd')
      await expect.poll(() => next.page.locator('#horizontal').evaluate(element => element.scrollLeft), { message: '向左滑动仍为原生横向滚动' }).toBeGreaterThan(0)
      expect(await opened(next.page)).toBe(false)
    }
    finally { await next.page.close() }
  })

  it('leaves native editable control gestures to the input', async () => {
    const { page, cdp } = await render()
    try {
      await page.locator('#draft').fill('draft')
      await page.locator('#draft').evaluate((element) => {
        element.style.marginTop = '80px'
      })
      const draft = await page.locator('#draft').boundingBox()
      expect(draft).not.toBeNull()
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x: draft!.x + 80, y: draft!.y + 10 })).toBe('draft')
      await touch(cdp, 'touchStart', draft!.x + 80, draft!.y + 10)
      await touch(cdp, 'touchMove', draft!.x + 180, draft!.y + 10)
      await touch(cdp, 'touchEnd')
      expect(await opened(page)).toBe(false)
    }
    finally { await page.close() }
  })

  it('cancels dragging and supports button, scrim and Escape without desktop changes', async () => {
    const { page, cdp } = await render()
    try {
      await touch(cdp, 'touchStart', 40)
      await touch(cdp, 'touchMove', 230)
      await touch(cdp, 'touchCancel')
      await expect.poll(() => offset(page)).toBe(0)
      expect(await opened(page)).toBe(false)
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 410)))
      await page.locator('[data-dsh-sidebar-toggle]').click()
      await expect.poll(() => opened(page)).toBe(true)
      await expect.poll(() => offset(page)).toBe(320)
      await page.locator('[data-dsh-sidebar-shade]').click({ position: { x: 5, y: 350 } })
      await expect.poll(() => opened(page)).toBe(false)
      await page.locator('[data-dsh-sidebar-toggle]').click()
      await page.keyboard.press('Escape')
      await expect.poll(() => opened(page)).toBe(false)
    }
    finally { await page.close() }
    const desktop = await render(false, 1280)
    try {
      expect(await desktop.page.locator('[data-dsh-mobile-sidebar]').count()).toBe(0)
      expect(await offset(desktop.page)).toBe(280)
      await touch(desktop.cdp, 'touchStart', 350)
      await touch(desktop.cdp, 'touchMove', 550)
      await touch(desktop.cdp, 'touchEnd')
      expect(await offset(desktop.page)).toBe(280)
    }
    finally { await desktop.page.close() }
  })
})
