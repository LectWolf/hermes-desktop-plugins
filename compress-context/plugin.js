/**
 * Compress-context — one-click /compress on the composer (left of the model
 * pill) and in the ⌘K palette. Calls session.compress with the same 11-minute
 * ceiling the built-in slash command uses; host.request's 30s default is too
 * short for the summarizer.
 */
import { useState } from 'react'
import {
  Button,
  Codicon,
  COMPOSER_AREAS,
  ConfirmDialog,
  PALETTE_AREA,
  Tip,
  atom,
  cn,
  haptic,
  host,
  usePluginI18n,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'compress-context'
const COMPRESS_TIMEOUT_MS = 660_000
const $compressing = atom(false)
const STYLE_ID = 'compress-context-style'

function ensureStyle() {
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = `
    [data-compress-context-btn] {
      margin-left: auto;
      flex: 0 0 auto;
    }
    [data-compress-context-btn] + * {
      margin-left: 0 !important;
    }
  `
}

function notify(kind, message) {
  host.notify({ kind, message })
}

async function runCompress() {
  if ($compressing.get()) {
    return
  }

  const sessionId = host.state.focusedSessionId.get()

  if (!sessionId) {
    notify('error', '没有活动会话')
    return
  }

  if (host.state.busy.get()) {
    notify('info', '等当前回合结束后再压缩')
    return
  }

  const gateway = typeof host.getGateway === 'function' ? host.getGateway() : null

  if (!gateway) {
    notify('error', '网关未连接')
    return
  }

  $compressing.set(true)
  haptic('tap')
  notify('info', '正在压缩上下文…')

  try {
    const result = await gateway.request(
      'session.compress',
      { session_id: sessionId },
      COMPRESS_TIMEOUT_MS
    )

    if (result?.status === 'pending') {
      notify('info', result.message || '压缩仍在后台进行，完成后对话会刷新')
      return
    }

    if (result?.lock_held) {
      notify('info', result.message || '已有压缩在进行')
      return
    }

    if (result?.summary?.headline) {
      const lines = [result.summary.headline, result.summary.token_line, result.summary.note].filter(Boolean)
      const aborted = result.status === 'aborted' || result.summary.aborted === true
      notify(aborted ? 'error' : 'success', lines.join('\n'))
      return
    }

    const removed = result?.removed ?? 0
    notify('success', removed > 0 ? `已压缩 ${removed} 条消息` : '没有可压缩的内容')
  } catch (err) {
    notify('error', err instanceof Error ? err.message : String(err))
  } finally {
    $compressing.set(false)
  }
}

function CompressButton() {
  const t = usePluginI18n(ID)
  const compressing = useValue($compressing)
  const busy = useValue(host.state.busy)
  const sessionId = useValue(host.state.focusedSessionId)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const disabled = compressing || busy || !sessionId
  const tip = !sessionId ? t('noSession') : busy ? t('waitBusy') : compressing ? t('working') : t('tip')

  return jsxs('span', {
    'data-compress-context-btn': '1',
    className: 'inline-flex shrink-0',
    children: [
      jsx(Tip, {
        label: tip,
        children: jsx(Button, {
          'aria-label': t('tip'),
          className: cn(
            'size-(--composer-control-size) shrink-0 rounded-md p-0',
            'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          ),
          disabled,
          onClick: () => {
            haptic('tap')
            setConfirmOpen(true)
          },
          size: 'icon-xs',
          type: 'button',
          variant: 'ghost',
          children: jsx(Codicon, {
            name: compressing ? 'loading' : 'fold',
            size: '0.875rem',
            spinning: compressing
          })
        })
      }),
      jsx(ConfirmDialog, {
        busyLabel: t('working'),
        cancelLabel: t('cancel'),
        confirmLabel: t('confirm'),
        description: t('confirmBody'),
        dismissOnConfirm: true,
        open: confirmOpen,
        title: t('confirmTitle'),
        onClose: () => setConfirmOpen(false),
        onConfirm: () => {
          void runCompress()
        }
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Compress Context',
  description: 'Composer button and ⌘K command to compress the current session context.',
  register(ctx) {
    ensureStyle()
    ctx.i18n.register({
      en: {
        tip: 'Compress context',
        noSession: 'No active session',
        waitBusy: 'Wait for the current turn to finish',
        working: 'Compressing…',
        confirmTitle: 'Compress context?',
        confirmBody:
          'Older turns become a summary; recent turns stay verbatim. This can take a minute on a long session.',
        confirm: 'Compress',
        cancel: 'Cancel',
        palette: 'Compress current context'
      },
      zh: {
        tip: '压缩上下文',
        noSession: '没有活动会话',
        waitBusy: '等当前回合结束后再压缩',
        working: '正在压缩…',
        confirmTitle: '压缩上下文？',
        confirmBody: '较早的对话会变成摘要，最近若干轮原文保留。长会话可能要一会儿。',
        confirm: '压缩',
        cancel: '取消',
        palette: '压缩当前会话上下文'
      }
    })

    ctx.register({
      id: 'composer-button',
      area: COMPOSER_AREAS.actions,
      order: 40,
      render: CompressButton
    })

    ctx.register({
      id: 'palette',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.run`,
        label: ctx.i18n.t('palette'),
        keywords: ['compress', 'compact', 'context', '压缩', '上下文'],
        run: () => {
          void runCompress()
        }
      }
    })
  }
}
