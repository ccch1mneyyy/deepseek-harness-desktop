// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const tauriRoot = new NodeURL('../src-tauri/', import.meta.url)
const stableConfig = JSON.parse(readFileSync(new NodeURL('tauri.conf.json', tauriRoot), 'utf8'))
const nightlyConfig = JSON.parse(readFileSync(new NodeURL('tauri.nightly.conf.json', tauriRoot), 'utf8'))
const stable = new DOMParser().parseFromString(
  readFileSync(new NodeURL(stableConfig.bundle.windows.wix.fragmentPaths[0], tauriRoot), 'utf8'),
  'text/xml',
)
const nightly = new DOMParser().parseFromString(
  readFileSync(new NodeURL(nightlyConfig.bundle.windows.wix.fragmentPaths[0], tauriRoot), 'utf8'),
  'text/xml',
)

it('stable MSI inherits legacy registered paths only when INSTALLDIR is unset after AppSearch', () => {
  const property = stable.querySelector('Property[Id="LEGACY_INSTALLDIR"]')!
  expect(property.getAttribute('Secure')).toBe('yes')
  expect([...property.querySelectorAll('RegistrySearch')].map(search => ({
    root: search.getAttribute('Root'),
    key: search.getAttribute('Key'),
    name: search.getAttribute('Name'),
    type: search.getAttribute('Type'),
  }))).toEqual([
    { root: 'HKCU', key: String.raw`Software\github\Deepseek Harness Desktop`, name: null, type: 'raw' },
    { root: 'HKCU', key: String.raw`Software\github\Deepseek Harness Desktop`, name: 'InstallDir', type: 'raw' },
    { root: 'HKCU', key: String.raw`Software\dsh-tauri\Deepseek Harness Desktop`, name: null, type: 'raw' },
    { root: 'HKCU', key: String.raw`Software\dsh-tauri\Deepseek Harness Desktop`, name: 'InstallDir', type: 'raw' },
  ])
  const assignment = stable.querySelector('SetProperty[Action="UseLegacyInstallDir"]')!
  expect(assignment.getAttribute('Id')).toBe('INSTALLDIR')
  expect(assignment.getAttribute('Value')).toBe('[LEGACY_INSTALLDIR]')
  expect(assignment.getAttribute('After')).toBe('AppSearch')
  expect(assignment.getAttribute('Sequence')).toBe('both')
  expect(assignment.textContent?.trim()).toBe('NOT INSTALLDIR AND LEGACY_INSTALLDIR')
})

it('stable MSI removes only the three old renamed shortcuts on a major upgrade', () => {
  const cleanup = stable.querySelector('Component[Id="CleanupLegacyShortcuts"]')!
  expect(cleanup.querySelector('Condition')?.textContent?.trim()).toBe('WIX_UPGRADE_DETECTED AND LEGACY_INSTALLDIR')
  expect([...cleanup.querySelectorAll('RemoveFile')].map(file => ({
    name: file.getAttribute('Name'),
    directory: file.getAttribute('Directory'),
    property: file.getAttribute('Property'),
    on: file.getAttribute('On'),
  }))).toEqual([
    { name: 'Deepseek Harness Desktop.lnk', directory: 'DesktopFolder', property: null, on: 'install' },
    { name: 'Deepseek Harness Desktop.lnk', directory: 'LegacyApplicationProgramsFolder', property: null, on: 'install' },
    { name: 'Uninstall Deepseek Harness Desktop.lnk', directory: null, property: 'LEGACY_INSTALLDIR', on: 'install' },
  ])
  expect(stable.querySelector('DirectoryRef[Id="ProgramMenuFolder"] > Directory[Id="LegacyApplicationProgramsFolder"]')?.getAttribute('Name'))
    .toBe('Deepseek Harness Desktop')
  expect(stableConfig.bundle.windows.wix.componentRefs).toEqual(['CleanupLegacyShortcuts'])
})

describe('msi channel cleanup isolation', () => {
  it('stable MSI keeps existing autostart targets during a major upgrade', () => {
    expect(stable.querySelector('DirectoryRef[Id="TARGETDIR"] > Directory[Id="SystemFolder"]')).not.toBeNull()
    for (const action of ['RemoveAutostartRunValue', 'RemoveAutostartApprovalValue']) {
      expect(stable.querySelector(`InstallExecuteSequence > Custom[Action="${action}"]`)?.textContent?.trim())
        .toBe('REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE')
      expect(stable.querySelector(`CustomAction[Id="${action}"]`)?.getAttribute('ExeCommand'))
        .toContain('/v "Deepseek Harness Desktop" /f')
    }
  })

  it('nightly MSI cannot inherit or clean any stable installation', () => {
    expect(nightlyConfig.bundle.windows.wix.fragmentPaths).toEqual(['./windows/fragments/autostart-cleanup-nightly.wxs'])
    expect(nightlyConfig.bundle.windows.wix.componentRefs).toEqual(['NightlyAutostartCleanup'])
    expect(nightly.querySelector('Component[Id="NightlyAutostartCleanup"] > RegistryValue')?.getAttribute('Key'))
      .toBe(String.raw`Software\dsh-tauri-nightly\DSH Tauri Nightly`)
    expect(nightly.querySelectorAll('RegistrySearch, SetProperty, RemoveFile')).toHaveLength(0)
    expect(nightly.querySelector('DirectoryRef[Id="TARGETDIR"] > Directory[Id="SystemFolder"]')).not.toBeNull()
    for (const action of ['RemoveAutostartRunValue', 'RemoveAutostartApprovalValue']) {
      expect(nightly.querySelector(`CustomAction[Id="${action}"]`)?.getAttribute('ExeCommand'))
        .toContain('/v "DSH Tauri Nightly" /f')
      expect(nightly.querySelector(`InstallExecuteSequence > Custom[Action="${action}"]`)?.textContent?.trim())
        .toBe('REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE')
    }
  })
})
