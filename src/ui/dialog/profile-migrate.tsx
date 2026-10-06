import type { PropsWithOverlays } from '@overlastic/react'
import type { HarnessCore, MigrateReport, MigrationAnalysis, MigrationDataItem, MigrationDataKind, MigrationEntry, MigrationVerdict, Profile } from '@/types'
import { ArrowDown, ArrowRight, ArrowUp } from '@gravity-ui/icons'
import { AlertDialog, Button, Checkbox, Chip, InputGroup, ListBox, Select, Spinner, Tabs } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { queryKeys } from '@/config/query-keys'
import { useDshPluginsManager } from '@/hooks/use-plugins-manager'
import { toast } from '@/utils/toast'

/** 判定结果 → Chip 颜色与文案 key；带目标版本的判定只用颜色 + 方向 Icon，文案留给 aria-label */
const VERDICT_CHIPS: Record<MigrationVerdict, { key: string, color: 'default' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  compatible: { key: 'profiles.migrate_verdict_compatible', color: 'default' },
  upgrade: { key: 'profiles.migrate_verdict_upgrade', color: 'success' },
  downgrade: { key: 'profiles.migrate_verdict_downgrade', color: 'warning' },
  unknown: { key: 'profiles.migrate_verdict_unknown', color: 'warning' },
}

/** 档案级数据类别 → 源档案里的文件名；不存在于源档案的类目也会列出（置灰） */
const DATA_FILES: Record<MigrationDataKind, string> = {
  patch: 'cordis.patch.yml',
  disabled: 'disabled-plugins.json',
  policy: 'pnpm-workspace.yaml',
  credentials: '.credentials.yaml',
}

/** 数据项的列出顺序：凭据固定最后（风险最高，默认不勾选） */
const DATA_ORDER: MigrationDataKind[] = ['patch', 'disabled', 'policy', 'credentials']

/** 档案级数据类别 → 说明文案 key（带条目数的用 `{{count}}` 插值） */
const DATA_LABEL_KEYS: Record<MigrationDataKind, string> = {
  patch: 'profiles.migrate_data_patch',
  disabled: 'profiles.migrate_data_disabled',
  policy: 'profiles.migrate_data_policy',
  credentials: 'profiles.migrate_data_credentials',
}

/**
 * 「迁移档案数据」对话框：把来源档案（对话框内选择）的插件与档案级数据并入当前档案。
 *
 * - 来源档案从档案列表里选（当前使用中的档案是固定目标，不可更改）；判定基准 = 当前核心版本。
 * - 插件走既有安装管线（`manager.install`），因此授权气泡与重启提示与插件面板一致；
 *   不兼容条目由后端给出应升级/降级到的版本，安装时仍按既有流程要求授权。
 * - 档案级数据由后端做纯增量合并（目标已有的条目一律不动，源档案保持原样）。
 */
export function ProfileMigrateDialog(props: PropsWithOverlays) {
  const disclosure = useDisclosure({ props })
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const manager = useDshPluginsManager()

  const { data: cores } = useQuery({
    queryKey: queryKeys.cores,
    queryFn: () => invoke<HarnessCore[]>('get_cores'),
  })
  const { data: profileList } = useQuery({
    queryKey: queryKeys.profiles,
    queryFn: () => invoke<Profile[]>('get_profiles'),
  })

  const profiles = profileList ?? []
  const target = profiles.find(profile => profile.active)
  const sources = profiles.filter(profile => !profile.active)

  const [pickedSourceId, setPickedSourceId] = useState('')

  const { data: analysis, isLoading, error } = useQuery({
    queryKey: queryKeys.profileMigration(pickedSourceId),
    queryFn: () => invoke<MigrationAnalysis>('analyze_profile_migration', { sourceId: pickedSourceId }),
    enabled: pickedSourceId !== '',
  })

  const [pluginOverrides, setPluginOverrides] = useState<Record<string, boolean>>({})
  const [dataOverrides, setDataOverrides] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  const activeCore = cores?.find(core => core.active)
  const coreVersion = activeCore ? activeCore.version || activeCore.tag : ''
  const plugins = analysis?.plugins ?? []
  const dataItems = analysis?.data ?? []

  /** 目标档案里同名插件的已装版本；null = 未安装 */
  function installedVersion(id: string): string | null {
    return manager.installed.find(plugin => plugin.id === id)?.version ?? null
  }

  /** 源档案里的这一类数据；undefined = 源档案没有这个文件 */
  function dataItem(kind: MigrationDataKind): MigrationDataItem | undefined {
    return dataItems.find(item => item.kind === kind)
  }

  /** 默认全部勾选（含目标已装的，勾选后按来源版本改写）；用户显式切换过的一律以用户为准 */
  function pluginPicked(entry: MigrationEntry): boolean {
    return pluginOverrides[entry.id] ?? true
  }

  /** 默认勾选：源档案里存在、且不是凭据的数据项（凭据可能含敏感信息，必须显式勾选） */
  function dataPicked(kind: MigrationDataKind): boolean {
    return dataOverrides[kind] ?? (dataItem(kind) !== undefined && kind !== 'credentials')
  }

  const pickedPlugins = plugins.filter(pluginPicked)
  const pickedData = DATA_ORDER.filter(dataPicked)
  const canSubmit = !busy && pickedSourceId !== '' && (pickedPlugins.length > 0 || pickedData.length > 0)

  function togglePlugin(id: string, next: boolean) {
    setPluginOverrides(previous => ({ ...previous, [id]: next }))
  }

  function toggleData(kind: MigrationDataKind, next: boolean) {
    setDataOverrides(previous => ({ ...previous, [kind]: next }))
  }

  function verdictLabel(entry: MigrationEntry): string {
    const chip = VERDICT_CHIPS[entry.verdict]
    return entry.targetVersion
      ? t(chip.key, { version: entry.targetVersion })
      : t(chip.key)
  }

  function dataLabel(kind: MigrationDataKind): string {
    const item = dataItem(kind)
    if (item === undefined || item.count === undefined)
      return t(DATA_LABEL_KEYS[kind], { count: '0' })
    return t(DATA_LABEL_KEYS[kind], { count: item.count })
  }

  async function submit() {
    if (!canSubmit)
      return
    const specs = pickedPlugins.map(entry => entry.spec)
    const kinds = pickedData
    setBusy(true)
    try {
      if (kinds.length > 0) {
        const report = await invoke<MigrateReport>('migrate_profile_data', {
          sourceId: pickedSourceId,
          items: kinds,
        })
        if (report.failures.length > 0) {
          const detail = report.failures.map(failure => dataLabel(failure.kind)).join('、')
          toast(t('profiles.migrate_partial'), { variant: 'danger', description: detail })
        }
      }
      let failed = 0
      if (specs.length > 0) {
        const results = await manager.install(specs)
        failed = results.filter(result => !result.ok).length
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins })
      if (failed > 0) {
        toast(t('profiles.migrate_plugin_failed', { count: failed }), { variant: 'danger' })
      }
      else {
        toast(t('profiles.migrate_success', { count: specs.length + kinds.length }), {
          variant: 'accent',
          description: t('profiles.migrate_success_hint'),
        })
      }
      disclosure.confirm()
    }
    catch (err) {
      console.error('[ProfileMigrateDialog] migrate failed:', err)
      toast(t('profiles.migrate_failed'), { variant: 'danger', description: String(err) })
      setBusy(false)
    }
  }

  return (
    <AlertDialog onOpenChange={disclosure.cancel} isOpen={disclosure.visible}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[560px]">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="accent" />
              <AlertDialog.Heading>{t('profiles.migrate_title')}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="space-y-4">
              <p className="text-xs leading-[1.7] text-muted">{t('profiles.migrate_desc')}</p>
              <div className="flex justify-between items-center gap-3">
                <Select
                  variant="secondary"
                  className="flex-1"
                  selectedKey={pickedSourceId}
                  onSelectionChange={key => setPickedSourceId(String(key))}
                  isDisabled={busy}
                  aria-label={t('profiles.migrate_source')}
                  placeholder={t('profiles.migrate_source')}
                >
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {sources.map(profile => (
                        <ListBox.Item id={profile.id} key={profile.id} textValue={profile.name}>
                          {profile.name}
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
                <ArrowRight className="size-4 shrink-0 text-muted" />
                <div className="flex-1">
                  <InputGroup fullWidth variant="secondary" className="relative">
                    <InputGroup.Input
                      disabled
                      className="min-w-0"
                      value={target?.name ?? ''}
                    />
                    <InputGroup.Suffix className="absolute right-0">
                      <Chip className="rounded-sm" color="success" variant="soft">{coreVersion}</Chip>
                    </InputGroup.Suffix>
                  </InputGroup>
                </div>
              </div>
              <If
                cond={pickedSourceId}
                else={(
                  <p className="py-4 text-sm text-muted">
                    {sources.length > 0 ? t('profiles.migrate_pick_source') : t('profiles.migrate_no_source')}
                  </p>
                )}
              >
                <If cond={isLoading}>
                  <div className="flex justify-center p-6">
                    <Spinner aria-label={t('profiles.migrate_analyzing')} />
                  </div>
                </If>
                <If cond={!isLoading && error !== null}>
                  <p className="p-4 text-sm text-danger">{t('profiles.migrate_analyze_failed')}</p>
                </If>
                <If cond={!isLoading && error === null}>
                  <Tabs defaultSelectedKey="plugins" variant="primary">
                    <Tabs.ListContainer>
                      <Tabs.List aria-label={t('profiles.migrate_title')}>
                        <Tabs.Tab id="plugins" className="h-7 px-3 text-xs">
                          {t('profiles.migrate_tab_plugins', { count: plugins.length })}
                          <Tabs.Indicator />
                        </Tabs.Tab>
                        <Tabs.Tab id="data" className="h-7 px-3 text-xs">
                          {t('profiles.migrate_tab_data')}
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      </Tabs.List>
                    </Tabs.ListContainer>
                    <Tabs.Panel id="plugins">
                      <If
                        cond={plugins.length === 0}
                        then={<p className="py-4 text-sm text-muted">{t('profiles.migrate_plugins_empty')}</p>}
                        else={plugins.map(entry => (
                          <label key={entry.id} className="flex cursor-pointer items-center gap-2 py-1.5">
                            <Checkbox
                              isSelected={pluginPicked(entry)}
                              isDisabled={busy}
                              onChange={(value: boolean) => togglePlugin(entry.id, value)}
                              aria-label={entry.id}
                              className="shrink-0"
                            >
                              <Checkbox.Content>
                                <Checkbox.Control>
                                  <Checkbox.Indicator />
                                </Checkbox.Control>
                                <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink">
                                  {entry.id}
                                  @
                                  {entry.version}
                                </span>
                              </Checkbox.Content>
                            </Checkbox>

                            <If cond={installedVersion(entry.id) !== null}>
                              <Chip size="sm" variant="soft">
                                {t('profiles.migrate_installed', { version: installedVersion(entry.id) ?? '' })}
                              </Chip>
                            </If>
                            <If
                              cond={entry.targetVersion !== undefined}
                              then={(
                                <Chip
                                  size="sm"
                                  color={VERDICT_CHIPS[entry.verdict].color}
                                  variant="soft"
                                  aria-label={verdictLabel(entry)}
                                >
                                  <If
                                    cond={entry.verdict === 'upgrade'}
                                    then={<ArrowUp className="size-2.5" />}
                                    else={<ArrowDown className="size-2  .5" />}
                                  />
                                  {entry.targetVersion}
                                </Chip>
                              )}
                              else={(
                                <Chip size="sm" color={VERDICT_CHIPS[entry.verdict].color} variant="soft">
                                  {verdictLabel(entry)}
                                </Chip>
                              )}
                            />
                          </label>
                        ))}
                      />
                    </Tabs.Panel>
                    <Tabs.Panel id="data" className="">
                      {DATA_ORDER.map(kind => (
                        <div key={kind} className="flex items-center gap-2 py-1">
                          <Checkbox
                            isSelected={dataPicked(kind)}
                            isDisabled={busy || dataItem(kind) === undefined}
                            onChange={(value: boolean) => toggleData(kind, value)}
                            aria-label={kind}
                          >
                            <Checkbox.Content>
                              <Checkbox.Control>
                                <Checkbox.Indicator />
                              </Checkbox.Control>
                              <span className="text-sm">
                                {DATA_FILES[kind]}
                              </span>
                              <If cond={dataItem(kind) === undefined}>
                                <span className="text-xs text-muted">{t('profiles.migrate_data_absent')}</span>
                              </If>
                            </Checkbox.Content>
                          </Checkbox>
                          <div className="flex-1" />
                          <span className="text-xs text-muted">{dataLabel(kind)}</span>
                          <If cond={kind === 'credentials'}>
                            <Chip size="sm" color="danger" variant="soft">
                              {t('profiles.migrate_credentials_badge')}
                            </Chip>
                          </If>
                        </div>
                      ))}
                    </Tabs.Panel>
                  </Tabs>
                </If>
              </If>
            </AlertDialog.Body>
            <AlertDialog.Footer className="justify-end">
              <div className="flex flex-row items-center gap-2">
                <Button variant="tertiary" isDisabled={busy} onPress={disclosure.cancel}>
                  {t('buttons.cancel')}
                </Button>
                <Button variant="primary" isDisabled={!canSubmit} onPress={submit}>
                  <If cond={busy} then={<Spinner size="sm" color="current" />} />
                  <If cond={busy} then={<span>{t('profiles.migrate_busy')}</span>} else={<span>{t('profiles.migrate_confirm')}</span>} />
                </Button>
              </div>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}
