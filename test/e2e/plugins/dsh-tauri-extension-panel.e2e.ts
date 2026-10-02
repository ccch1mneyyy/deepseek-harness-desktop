import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectNoSyntheticFallbacks, launchDshBrowser, newDshPage } from '../support/browser'

let browser: Browser
beforeAll(async () => {
  browser = await launchDshBrowser()
})
afterAll(async () => {
  await browser?.close()
})

describe('extension panel official plugins composition', () => {
  it('hides the original sidebar row and mounts the official page only while its first tab is active', async () => {
    const app = await newDshPage(browser, { ready: '[data-dsh-hidden-panel="plugins"]' })
    try {
      const originalRow = app.frame.locator('button:has([data-dsh-hidden-panel="plugins"])')
      expect(await originalRow.count(), '原插件入口必须保留注册但隐藏整行').toBe(1)
      expect(await originalRow.evaluate(el => getComputedStyle(el).display)).toBe('none')
      expect(await originalRow.isVisible()).toBe(false)

      await app.frame.getByRole('button', { name: '扩展管理', exact: true }).click()
      const tabs = app.frame.getByRole('tablist', { name: '扩展管理' })
      const pluginsTab = tabs.getByRole('tab', { name: '插件', exact: true })
      await expect.poll(() => tabs.getByRole('tab').first().textContent()).toBe('插件')
      await expect.poll(() => pluginsTab.getAttribute('aria-selected')).toBe('true')

      const officialPage = app.frame.locator('[data-dsh-extension-plugins] [data-plugin-panel]')
      await expect.poll(() => officialPage.isVisible(), { message: '首 Tab 必须渲染真实官方插件页面' }).toBe(true)
      expect(await officialPage.count()).toBe(1)
      expect(await officialPage.evaluate((el) => {
        const style = getComputedStyle(el)
        return { padding: style.padding, overflow: style.overflow }
      })).toEqual({ padding: '0px', overflow: 'visible' })
      expect(await officialPage.locator(':scope > header[data-window-drag]').evaluate(el => getComputedStyle(el).paddingTop)).toBe('0px')

      await tabs.getByRole('tab', { name: '技能', exact: true }).click()
      const skillsPanel = app.frame.getByRole('tabpanel', { name: '技能', exact: true })
      await expect.poll(() => skillsPanel.isVisible()).toBe(true)
      await expect.poll(() => app.frame.locator('[data-plugin-panel]').count(), { message: '离开插件 Tab 必须卸载官方页面，不能仅 hidden' }).toBe(0)

      await tabs.getByRole('tab', { name: 'MCP', exact: true }).click()
      expect(await skillsPanel.count(), '其他已访问 Tab 仍须保留挂载').toBe(1)
      expect(await skillsPanel.isVisible()).toBe(false)
      await pluginsTab.click()
      await expect.poll(() => officialPage.isVisible()).toBe(true)
      expect(await originalRow.isVisible()).toBe(false)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '复用官方页面和切换 Tab 不得产生浏览器错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })
})
