import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { Button } from '../components/button'
import { Gear } from '../components/icons'
import { Select } from '../components/select'
import { SETTINGS_LAUNCHER_SLOT, SETTINGS_REGISTRANT, SETTINGS_TRIGGER_PRIORITY } from '../constants'
import { detectMobileDevice } from '../utils/device'

export const registerMobilePreferences = defineRegister<ClientContext>((controller, ctx) => {
  if (!detectMobileDevice())
    return

  let selected = false
  const fiber = ctx.inject(['theme', 'configForms'], (scoped) => {
    const form = scoped.configForms.get('ui-chat')
    let active = true
    let cancelSelection: (() => void) | undefined
    const selectStandard = (): void => {
      cancelSelection?.()
      cancelSelection = undefined
      if (!active || selected || form.getSnapshot().status === 'loading')
        return
      const row = scoped.slots.entriesOfSlot('settings.general.item').find(entry => entry.options.id === 'transcript-view')
      const injected = row?.inject?.()
      if (typeof injected?.setTranscriptView !== 'function')
        return
      selected = true
      injected.setTranscriptView('standard')
    }
    const scheduleStandard = (): void => {
      if (!active || selected)
        return
      cancelSelection?.()
      cancelSelection = controller.timeout(selectStandard, 0)
    }
    const unsubscribeForm = form.subscribe(scheduleStandard)
    const unsubscribeSlot = scoped.slots.subscribe('settings.general.item', scheduleStandard)
    scheduleStandard()

    const subscribeTheme = (listener: () => void) => scoped.on('theme/change', listener)
    const getTheme = () => scoped.theme.getTheme()
    const subscribeLocale = (listener: () => void) => scoped.locale.subscribe(listener)
    const getLocale = () => scoped.locale.getSnapshot()
    const themeText = scoped.locale.bind('settings.theme')
    const languageText = scoped.locale.bind('settings.locale')
    const settingsText = scoped.locale.bind('settings')

    function MobilePreferences({ openSettings, settingsOpen }: SettingsLauncherOwnerProps) {
      const theme = useSyncExternalStore(subscribeTheme, getTheme)
      const locale = useSyncExternalStore(subscribeLocale, getLocale)

      return (
        <div data-dsh-mobile-preferences style={{ display: 'flex', flex: 1, minWidth: 0, alignItems: 'center', gap: 8, padding: '8px 0' }}>
          <Select
            label={themeText('appearance.title')}
            value={theme.active.colorScheme}
            options={[
              { value: 'light', label: themeText('appearance.light') },
              { value: 'dark', label: themeText('appearance.dark') },
            ]}
            onChange={id => scoped.theme.setTheme(id)}
          />
          <Select
            label={languageText('language.title')}
            value={locale.active}
            options={locale.locales.map(entry => ({ value: entry.id, label: entry.label }))}
            onChange={id => scoped.locale.setLocale(id)}
          />
          <Button
            aria-label={settingsText('trigger')}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            icon={<Gear width={16} height={16} />}
            style={{ marginLeft: 'auto', flexShrink: 0 }}
            onClick={openSettings}
          />
        </div>
      )
    }

    const unregister = scoped.slots.inject(SETTINGS_LAUNCHER_SLOT, () => scoped.slots.register(
      { name: SETTINGS_LAUNCHER_SLOT, priority: SETTINGS_TRIGGER_PRIORITY, registrant: SETTINGS_REGISTRANT },
      MobilePreferences,
    ))
    return () => {
      active = false
      cancelSelection?.()
      unsubscribeForm()
      unsubscribeSlot()
      unregister()
    }
  })
  controller.add(() => {
    void fiber.dispose()
  })
})
