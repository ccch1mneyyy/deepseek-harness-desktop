// @vitest-environment jsdom
import { OverlaysProvider, useOverlay } from '@overlastic/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { mockIPC } from '@tauri-apps/api/mocks'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileMigrateDialog } from './profile-migrate'

const { install, toast } = vi.hoisted(() => ({
  install: vi.fn(async (refs: string[]) => refs.map(spec => ({ ok: true, spec }))),
  toast: vi.fn(),
}))

vi.mock('@/hooks/use-plugins-manager', () => ({
  useDshPluginsManager: () => ({
    installed: [{ id: '@scope/installed', version: '0.1.0' }],
    install,
  }),
}))
vi.mock('@/utils/toast', () => ({ toast }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

if (typeof CSS === 'undefined')
  vi.stubGlobal('CSS', { escape: (value: string) => value })

Element.prototype.getAnimations = function () {
  return []
}

const analysis = {
  plugins: [
    { id: '@scope/installed', version: '0.1.0', spec: '@scope/installed@0.1.0', verdict: 'compatible' },
    { id: '@scope/fresh', version: '2.1.0', spec: '@scope/fresh@2.0.0', verdict: 'downgrade', targetVersion: '2.0.0' },
  ],
  data: [{ kind: 'patch', count: 2 }, { kind: 'policy', count: 1 }, { kind: 'credentials' }],
}

let client: QueryClient
let calls: Record<string, unknown[]>

function Launcher() {
  const open = useOverlay(ProfileMigrateDialog)
  function handleOpen() {
    void open().catch(() => {})
  }
  return <button onClick={handleOpen}>Open migrate</button>
}

async function openDialog() {
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <OverlaysProvider>
          <Launcher />
        </OverlaysProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
  fireEvent.click(screen.getByText('Open migrate'))
  fireEvent.click(await screen.findByRole('button', { name: /profiles\.migrate_source/ }))
  fireEvent.click(await screen.findByRole('option', { name: 'core-021' }))
  await screen.findByRole('checkbox', { name: '@scope/installed' })
}

async function submit() {
  fireEvent.click(screen.getByText('profiles.migrate_confirm'))
  await waitFor(() => expect(calls.install).toBeDefined())
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  calls = {}
  install.mockClear()
  install.mockImplementation(async (refs: string[]) => {
    calls.install = refs
    return refs.map(spec => ({ ok: true, spec }))
  })
  toast.mockReset()
  mockIPC((command, args) => {
    if (command === 'get_cores')
      return [{ id: 'app', source: 'app', version: '0.1.7', tag: 'dsh-0.1.7', active: true }]
    if (command === 'get_profiles')
      return [{ id: 'core-021', name: 'core-021' }, { id: 'web', name: 'web', active: true }]
    if (command === 'get_dsh_plugins')
      return []
    if (command === 'analyze_profile_migration') {
      calls.analyze = [args]
      return analysis
    }
    if (command === 'migrate_profile_data') {
      calls.migrate = [args]
      return { applied: (args as { items: string[] }).items, skipped: [], failures: [] }
    }
    throw new Error(`Unexpected command: ${command}`)
  })
})

afterEach(() => {
  cleanup()
  client.clear()
})

describe('profileMigrateDialog', () => {
  it('插件默认全部勾选，凭据必须显式勾选', async () => {
    await openDialog()
    await submit()

    expect(calls.migrate).toEqual([{ sourceId: 'core-021', items: ['patch', 'policy'] }])
    expect(calls.install).toEqual(['@scope/installed@0.1.0', '@scope/fresh@2.0.0'])
  })

  it('取消勾选已安装的插件后不再随迁移安装', async () => {
    await openDialog()
    fireEvent.click(screen.getByRole('checkbox', { name: '@scope/installed' }))
    await submit()

    expect(calls.install).toEqual(['@scope/fresh@2.0.0'])
  })

  it('凭据必须显式勾选才会迁移', async () => {
    await openDialog()
    fireEvent.click(screen.getByText('profiles.migrate_tab_data'))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'credentials' }))
    await submit()

    expect(calls.migrate).toEqual([{ sourceId: 'core-021', items: ['patch', 'policy', 'credentials'] }])
  })
})
