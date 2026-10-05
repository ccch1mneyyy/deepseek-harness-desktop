import { defineLocale } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'

const zh = {
  'toggle.open': '打开侧边栏',
  'toggle.close': '收起侧边栏',
  'shade.close': '关闭侧边栏',
  'navbar.label': '会话导航',
  'session.new': '新会话',
  'session.failed': '无法新建会话，请重试',
} as const

const en: Record<keyof typeof zh, string> = {
  'toggle.open': 'Open sidebar',
  'toggle.close': 'Close sidebar',
  'shade.close': 'Close sidebar',
  'navbar.label': 'Conversation navigation',
  'session.new': 'New Session',
  'session.failed': 'Unable to start a session. Please try again.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-tauri-mobile-ui': keyof typeof zh
  }
}

export const locale = defineLocale(PLUGIN_ID, { zh, en })
