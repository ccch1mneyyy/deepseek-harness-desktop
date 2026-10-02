import type { SegmentedControlProps } from '../../../../dsh-tauri-ui/src/client/components/segmented-control'
import type { MarketFace } from '../service/market.types'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionPanel } from './extension-panel'

vi.mock('dsh-tauri/client', async () => import('../../../../dsh-tauri/src/client/modules/reause'))
vi.mock('dsh-tauri-ui/client', () => ({
  SegmentedControl: ({ options, value }: SegmentedControlProps) => <nav data-active={value}>{options.map(option => <span key={option.value}>{option.value}</span>)}</nav>,
}))
vi.mock('../locales', () => ({ locale: { text: (key: string) => key } }))
vi.mock('./skills-tab', () => ({ SkillsTab: () => <section>skills-content</section> }))
vi.mock('./mcp-tab', () => ({ McpTab: () => <section>mcp-content</section> }))

afterEach(() => vi.restoreAllMocks())

describe('extension panel composition', () => {
  it('renders the official plugins element as the first selected tab', () => {
    const render = vi.fn(() => <section>installed-market-content</section>)
    const market: MarketFace = { version: 1, render, setSettingsVisible: vi.fn(), settingsVisible: () => false }
    const markup = renderToStaticMarkup(<ExtensionPanel plugins={<section>official-plugins-content</section>} market={market} createSkill={async () => {}} />)
    expect(markup).toContain('data-active="plugins"')
    expect(markup).toContain('<span>plugins</span><span>market</span><span>skills</span><span>mcp</span>')
    expect(markup).toContain('official-plugins-content')
    expect(render).not.toHaveBeenCalled()
    expect(markup).not.toContain('skills-content')
    expect(markup).not.toContain('mcp-content')
  })

  it('renders plugins without the optional market service', () => {
    const markup = renderToStaticMarkup(<ExtensionPanel plugins={<section>official-plugins-content</section>} market={undefined} createSkill={async () => {}} />)
    expect(markup).toContain('data-active="plugins"')
    expect(markup).toContain('<span>plugins</span><span>skills</span><span>mcp</span>')
    expect(markup).toContain('official-plugins-content')
  })

  it('renders the market element with the installed subsection preference when plugins are unavailable', () => {
    const render = vi.fn(() => <section>installed-market-content</section>)
    const market: MarketFace = { version: 1, render, setSettingsVisible: vi.fn(), settingsVisible: () => false }
    const markup = renderToStaticMarkup(<ExtensionPanel market={market} createSkill={async () => {}} />)
    expect(markup).toContain('data-active="market"')
    expect(markup).toContain('<span>market</span><span>skills</span><span>mcp</span>')
    expect(render).toHaveBeenCalledExactlyOnceWith({ preferredSubsectionId: 'installed' })
    expect(markup).toContain('installed-market-content')
    expect(markup).not.toContain('skills-content')
    expect(markup).not.toContain('mcp-content')
  })

  it('renders skills when both optional pages are unavailable', () => {
    const markup = renderToStaticMarkup(<ExtensionPanel market={undefined} createSkill={async () => {}} />)
    expect(markup).toContain('data-active="skills"')
    expect(markup).toContain('<span>skills</span><span>mcp</span>')
    expect(markup).toContain('skills-content')
    expect(markup).not.toContain('installed-market-content')
    expect(markup).not.toContain('mcp-content')
  })
})
