/**
 * Turn Usage
 * - One centered session bar above the composer (本轮 + 会话 + 缓存 + 花费 + 今日 + 模型).
 * - After Stop / model finish: centered outlined badge under that turn's last reply.
 */
import { useEffect, useState } from 'react'
import { COMPOSER_AREAS, atom, haptic, host, useValue } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'

const ID = 'turn-usage'
const BADGE_ATTR = 'data-turn-usage-badge'
const HOST_ATTR = 'data-turn-usage-host'
const WRAP_ATTR = 'data-turn-usage-wrap'
const LIVE_ATTR = 'data-turn-usage-live'
const STORAGE_KEY = 'completed-turns'
const DAILY_KEY = 'daily-spend'
const MAX_TURNS = 40

const BADGE_STYLE = {
  display: 'inline-flex',
  maxWidth: '100%',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'center',
  columnGap: '6px',
  rowGap: '2px',
  borderRadius: '6px',
  border: '1px solid var(--ui-stroke-secondary)',
  background: 'transparent',
  padding: '2px 8px',
  fontSize: '0.6875rem',
  lineHeight: '1rem',
  color: 'var(--ui-text-tertiary)',
  fontVariantNumeric: 'tabular-nums',
  cursor: 'pointer',
  textAlign: 'center'
}

const EFFORT_LABEL = {
  none: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra'
}

const PRICE_URL =
  'https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json'
const PRICE_CACHE_KEY = 'model-prices'
const PRICE = {
  'grok-4.6': { in: 2, cache: 0.5, out: 6, longIn: 4, longCache: 1, longOut: 12, longAt: 200000 },
  'grok-4.5': { in: 2, cache: 0.3, out: 6, longIn: 4, longCache: 0.6, longOut: 12, longAt: 200000 },
  'grok-4': { in: 3, cache: 0.75, out: 15, longIn: 3, longCache: 0.75, longOut: 15, longAt: Infinity }
}

const $live = atom({
  running: false,
  sessionId: null,
  startedAt: 0,
  snap: emptySnap(),
  prev: emptySnap(),
  acc: emptyAcc()
})
const $completed = atom({})
const $sessionClock = atom({ sessionId: null, startedAt: 0 })
const $effort = atom('')
const $daily = atom({ date: '', usd: 0 })
const $lastTurn = atom(null)

let anchorEl = null
let writeClipboard = null
let pluginStorage = null
let remoteRates = null
let observer = null
let finishTimer = null
let rehomeTimer = null

function emptySnap() {
  return {
    input: 0,
    prompt: 0,
    output: 0,
    total: 0,
    cache: 0,
    calls: 0,
    cost: null,
    cacheHit: null,
    avgLatency: null
  }
}

function emptyAcc() {
  return { input: 0, output: 0, cache: 0, calls: 0, cost: 0, apiSec: 0 }
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function snapUsage(usage) {
  if (!usage || typeof usage !== 'object') return emptySnap()
  const cost = usage.cost_usd
  const hitRaw = usage.cache_hit_pct
  const hit = typeof hitRaw === 'number' && Number.isFinite(hitRaw) ? hitRaw : null
  const uncached = num(usage.input)
  const promptField = num(usage.prompt)
  const output = num(usage.output)
  const billed = promptField > 0 ? promptField : uncached
  let cache = 0
  if (hit != null && billed > 0) cache = billed * (Math.max(0, Math.min(100, hit)) / 100)
  else if (promptField > uncached) cache = promptField - uncached
  const avgRaw = usage.avg_latency_s
  return {
    input: uncached,
    prompt: billed,
    output,
    total: num(usage.total) || billed + output,
    cache,
    calls: num(usage.calls),
    cost: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
    cacheHit: hit,
    avgLatency: typeof avgRaw === 'number' && Number.isFinite(avgRaw) && avgRaw > 0 ? avgRaw : null
  }
}

function compact(n) {
  const v = Math.max(0, num(n))
  if (v < 1000) return String(Math.round(v))
  if (v < 1_000_000) {
    const s = (v / 1000).toFixed(v < 10_000 ? 1 : 0)
    return s.replace(/\.0$/, '') + 'K'
  }
  const s = (v / 1_000_000).toFixed(v < 10_000_000 ? 1 : 0)
  return s.replace(/\.0$/, '') + 'M'
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(num(seconds)))
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest ? `${m}分${String(rest).padStart(2, '0')}秒` : `${m}分`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm ? `${h}小时${String(mm).padStart(2, '0')}分` : `${h}小时`
}

function modelKey(model) {
  return String(model || '')
    .split('/')
    .pop()
    .trim()
    .toLowerCase()
}

function fromMillion(row) {
  return {
    in: row.in / 1e6,
    cache: row.cache / 1e6,
    write: (row.write ?? row.in) / 1e6,
    out: row.out / 1e6,
    longIn: (row.longIn ?? row.in) / 1e6,
    longCache: (row.longCache ?? row.cache) / 1e6,
    longWrite: (row.longWrite ?? row.write ?? row.in) / 1e6,
    longOut: (row.longOut ?? row.out) / 1e6,
    longAt: row.longAt ?? Infinity
  }
}

function fromRemoteEntry(entry) {
  const inn = num(entry?.input_cost_per_token)
  const out = num(entry?.output_cost_per_token)
  if (inn <= 0 && out <= 0) return null
  const cache = num(entry.cache_read_input_token_cost) || inn
  const write = num(entry.cache_creation_input_token_cost) || inn
  const longIn = num(entry.input_cost_per_token_above_200k_tokens)
  const longCache = num(entry.cache_read_input_token_cost_above_200k_tokens)
  const longWrite = num(entry.cache_creation_input_token_cost_above_200k_tokens)
  const longOut = num(entry.output_cost_per_token_above_200k_tokens)
  return {
    in: inn || 0,
    cache,
    write,
    out: out || 0,
    longIn: longIn || inn || 0,
    longCache: longCache || cache,
    longWrite: longWrite || write,
    longOut: longOut || out || 0,
    longAt: longIn || longOut ? 200000 : Infinity
  }
}

function lookupRates(table, id) {
  if (!table || !id) return null
  if (table[id]) return table[id]
  const keys = Object.keys(table)
  const hit =
    keys.find(k => k === id) ||
    keys.find(k => k.endsWith('/' + id) || k.endsWith(':' + id)) ||
    keys.find(k => k.split('/').pop() === id) ||
    keys.find(k => k.replace(/_/g, '-') === id) ||
    keys.find(k => k.split('/').pop().replace(/_/g, '-') === id)
  return hit ? table[hit] : null
}

function ratesFor(model) {
  const id = modelKey(model)
  const remote = lookupRates(remoteRates, id)
  if (remote) return remote
  if (PRICE[id]) return fromMillion(PRICE[id])
  const key = Object.keys(PRICE).find(k => id === k || id.startsWith(k))
  return key ? fromMillion(PRICE[key]) : null
}

function estimateBuckets(parts, model) {
  const rates = ratesFor(model)
  if (!rates) return null
  const cacheTok = Math.max(0, num(parts.cache))
  const writeTok = Math.max(0, num(parts.cacheWrite))
  const out = Math.max(0, num(parts.output))
  const billed = Math.max(0, num(parts.billed) || num(parts.uncached) + cacheTok + writeTok)
  const fresh = Math.max(0, parts.uncached != null ? num(parts.uncached) : billed - cacheTok - writeTok)
  const n = Math.max(1, num(parts.calls) || 1)
  const long = billed / n >= rates.longAt
  const inRate = long ? rates.longIn : rates.in
  const cacheRate = long ? rates.longCache : rates.cache
  const writeRate = long ? rates.longWrite || rates.write || inRate : rates.write || inRate
  const outRate = long ? rates.longOut : rates.out
  return fresh * inRate + cacheTok * cacheRate + writeTok * writeRate + out * outRate
}

function estimateCost(input, output, cacheHit, model) {
  const billed = Math.max(0, num(input))
  const hit = Math.max(0, Math.min(100, num(cacheHit))) / 100
  return estimateBuckets({ billed, cache: billed * hit, output, uncached: billed * (1 - hit), calls: 1 }, model)
}

function costForSnap(row, model) {
  if (typeof row.cost === 'number' && row.cost > 0) return row.cost
  const billed = num(row.prompt) || num(row.input)
  const cache = num(row.cache)
  const uncached = num(row.prompt) > num(row.input) ? num(row.input) : Math.max(0, billed - cache)
  return estimateBuckets(
    {
      billed,
      uncached,
      cache,
      cacheWrite: Math.max(0, billed - uncached - cache),
      output: row.output,
      calls: Math.max(1, num(row.calls))
    },
    model
  )
}

function ingestPriceJson(json) {
  if (!json || typeof json !== 'object') return null
  const models = {}
  for (const [name, entry] of Object.entries(json)) {
    const row = fromRemoteEntry(entry)
    if (!row) continue
    const full = String(name).toLowerCase()
    const short = modelKey(full)
    models[full] = row
    if (!models[short]) models[short] = row
  }
  return Object.keys(models).length ? models : null
}

async function loadRemotePrices() {
  if (remoteRates) return
  try {
    const saved = await pluginStorage?.get?.(PRICE_CACHE_KEY)
    const sample = saved?.models && typeof saved.models === 'object' ? Object.values(saved.models)[0] : null
    if (sample && typeof sample.in === 'number') {
      remoteRates = saved.models
      return
    }
    const cached = ingestPriceJson(saved?.models) || ingestPriceJson(saved)
    if (cached) {
      remoteRates = cached
      return
    }
  } catch {
    /* miss */
  }
  try {
    const res = await fetch(PRICE_URL)
    if (!res.ok) return
    const json = await res.json()
    const models = ingestPriceJson(json)
    if (!models) return
    remoteRates = models
    if (pluginStorage?.set) {
      await pluginStorage.set(PRICE_CACHE_KEY, { fetchedAt: Date.now(), models })
    }
  } catch {
    /* keep built-in PRICE */
  }
}

function formatMoney(usd) {
  const n = typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : 0
  return `$${n.toFixed(2)}`
}

function prettyModel(slug) {
  const raw = String(slug || '').trim()
  if (!raw) return ''
  let id = raw.split('/').pop()
  id = id.replace(/^grok-/i, 'Grok ').replace(/^gpt-/i, 'GPT-').replace(/^claude-/i, 'Claude ')
  id = id.replace(/-/g, ' ')
  return id.replace(/\s+/g, ' ').trim()
}

function effortLabel(effort) {
  const key = String(effort || '').trim().toLowerCase()
  if (!key || key === 'none') return ''
  return EFFORT_LABEL[key] || effort
}

function modelTag(model, effort) {
  const name = prettyModel(model)
  const level = effortLabel(effort)
  if (name && level) return `${name} · ${level}`
  return name || level
}

function resolveCost(row, model) {
  if (typeof row.cost === 'number' && row.cost > 0) return row.cost
  return costForSnap(row, model)
}

function cacheTokens(row) {
  const billed = num(row.prompt) || num(row.input) || num(row.total)
  const amount =
    num(row.cache) || billed * (Math.max(0, Math.min(100, num(row.cacheHit))) / 100)
  const hit =
    row.cacheHit != null
      ? Math.max(0, Math.min(100, num(row.cacheHit)))
      : billed > 0
        ? (amount / billed) * 100
        : 0
  return { amount, hit }
}

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dailyUsd() {
  const cur = $daily.get()
  return cur.date === todayKey() ? num(cur.usd) : 0
}

function persistDaily(next) {
  if (!pluginStorage || typeof pluginStorage.set !== 'function') return
  void Promise.resolve(pluginStorage.set(DAILY_KEY, next)).catch(() => undefined)
}

function addDaily(usd) {
  const amount = num(usd)
  if (amount <= 0) return
  const key = todayKey()
  const cur = $daily.get()
  const next = { date: key, usd: (cur.date === key ? num(cur.usd) : 0) + amount }
  $daily.set(next)
  persistDaily(next)
}

function sessionBarParts(turn, session, { model = '', effort = '', today = 0 } = {}) {
  const sessTotal = num(session.total) || num(session.prompt) || num(session.input) + num(session.output)
  const cache = cacheTokens(session)
  const parts = [
    `本轮 输入 ${compact(turn.input)} 输出 ${compact(turn.output)}`,
    `会话 ${compact(sessTotal)}`
  ]
  if (cache.amount > 0 || cache.hit > 0) parts.push(`缓存 ${compact(cache.amount)} (${Math.round(cache.hit)}%)`)
  parts.push(`花费 ${formatMoney(resolveCost(session, model))}`)
  parts.push(`今日 ${formatMoney(today)}`)
  const tag = modelTag(model, effort)
  if (tag) parts.push(tag)
  return parts
}

function sessionBarText(turn, session, opts) {
  return sessionBarParts(turn, session, opts).join(' ')
}

function lineParts(row, { model = '', effort = '' } = {}) {
  const parts = [formatDuration(row.durationSec), `输入 ${compact(row.input)}`, `输出 ${compact(row.output)}`]
  const cache = cacheTokens(row)
  if (cache.amount > 0 || cache.hit > 0) parts.push(`缓存 ${compact(cache.amount)} (${Math.round(cache.hit)}%)`)
  parts.push(`花费 ${formatMoney(resolveCost(row, model))}`)
  const tag = modelTag(model, effort)
  if (tag) parts.push(tag)
  return parts
}

function lineText(row, opts) {
  return lineParts(row, opts).join(' ')
}

function copyText(text) {
  if (typeof writeClipboard === 'function') {
    void writeClipboard(text)
    return
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text)
  }
}

function watchAtom(atomLike, fn) {
  if (!atomLike) return () => {}
  if (typeof atomLike.listen === 'function') {
    try {
      fn(atomLike.get())
    } catch {
      /* ignore */
    }
    return atomLike.listen(fn)
  }
  if (typeof atomLike.subscribe === 'function') return atomLike.subscribe(fn)
  return () => {}
}

function paneRoot(from) {
  let node = from
  for (let i = 0; i < 16 && node; i += 1) {
    if (node.querySelector?.('[data-slot="aui_assistant-message-root"]')) return node
    node = node.parentElement
  }
  return document
}

function assistantRoots(scope) {
  return [...(scope || document).querySelectorAll('[data-slot="aui_assistant-message-root"]')]
}

function isStreaming(root) {
  return Boolean(root.querySelector('[data-slot="aui_message-streaming-marker"][data-message-streaming="true"]'))
}

function messageKey(root) {
  if (!root) return null
  return (
    root.getAttribute('data-message-id') ||
    root.closest('[data-message-id]')?.getAttribute('data-message-id') ||
    null
  )
}

function lastSettledAssistant(from) {
  const roots = assistantRoots(paneRoot(from || anchorEl))
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    if (!isStreaming(roots[i])) return { root: roots[i], index: i, roots }
  }
  if (!roots.length) return { root: null, index: -1, roots }
  return { root: roots[roots.length - 1], index: roots.length - 1, roots }
}

function badgeWrap(hostNode) {
  let wrap = hostNode.querySelector(`[${WRAP_ATTR}]`)
  if (!wrap) {
    wrap = document.createElement('div')
    wrap.setAttribute(WRAP_ATTR, '1')
    Object.assign(wrap.style, {
      display: 'flex',
      justifyContent: 'center',
      width: '100%',
      marginTop: '8px'
    })
    const content = hostNode.querySelector('[data-slot="aui_assistant-message-content"]')
    if (content && content.parentNode === hostNode) content.after(wrap)
    else hostNode.appendChild(wrap)
  }
  return wrap
}

function ensureBadge(hostNode, row) {
  if (!hostNode || !row) return
  const wrap = badgeWrap(hostNode)
  for (const extra of [...wrap.querySelectorAll(`[${BADGE_ATTR}]`)]) {
    if (extra.getAttribute(BADGE_ATTR) !== row.id) extra.remove()
  }
  let badge = wrap.querySelector(`[${BADGE_ATTR}="${row.id}"]`)
  if (!badge) {
    badge = document.createElement('button')
    badge.type = 'button'
    badge.setAttribute(BADGE_ATTR, row.id)
    Object.assign(badge.style, {
      ...BADGE_STYLE,
      width: 'auto',
      maxWidth: '100%',
      cursor: 'pointer'
    })
    badge.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      haptic('tap')
      copyText(badge.textContent || '')
      host.notify({ kind: 'success', message: '已复制本轮用量' })
    })
    wrap.appendChild(badge)
  }
  const model = row.model || host.state.model.get()
  const effort = row.effort || $effort.get()
  ensureStyle()
  renderSegments(badge, lineParts(row, { model, effort }), { tight: true })
  const text = lineText(row, { model, effort })
  badge.title = text
  hostNode.setAttribute(HOST_ATTR, row.id)
}

function findTarget(scope, row, roots) {
  if (row.messageId) {
    const escaped = row.messageId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const tagged = scope.querySelector(`[data-message-id="${escaped}"]`)
    if (tagged) {
      return tagged.matches?.('[data-slot="aui_assistant-message-root"]')
        ? tagged
        : tagged.querySelector('[data-slot="aui_assistant-message-root"]') ||
            tagged.closest('[data-slot="aui_assistant-message-root"]')
    }
  }
  if (row.rootIndex != null && roots[row.rootIndex] && !isStreaming(roots[row.rootIndex])) {
    return roots[row.rootIndex]
  }
  return null
}

function rehomeAll() {
  const sessionId = host.state.focusedSessionId.get()
  const list = ($completed.get()[sessionId] || []).slice()
  if (!list.length) return
  const scope = paneRoot(anchorEl)
  const roots = assistantRoots(scope)
  const used = new Set()
  for (const row of list.slice().reverse()) {
    const target = findTarget(scope, row, roots)
    if (!target || used.has(target)) continue
    used.add(target)
    ensureBadge(target, row)
  }
}

function scheduleRehome() {
  if (rehomeTimer) clearTimeout(rehomeTimer)
  rehomeTimer = setTimeout(() => {
    rehomeTimer = null
    rehomeAll()
  }, 80)
}

function persistCompleted(map) {
  if (!pluginStorage || typeof pluginStorage.set !== 'function') return
  void Promise.resolve(pluginStorage.set(STORAGE_KEY, map)).catch(() => undefined)
}

function pushCompleted(row) {
  const sid = row.sessionId || '_'
  const map = { ...$completed.get() }
  const list = [...(map[sid] || [])].filter(item => {
    if (item.id === row.id) return false
    if (row.messageId && item.messageId && item.messageId === row.messageId) return false
    return true
  })
  list.push(row)
  map[sid] = list.slice(-MAX_TURNS)
  $completed.set(map)
  persistCompleted(map)
}

function composerRoot() {
  if (anchorEl) {
    const found = anchorEl.closest('[data-slot="composer-root"]')
    if (found) return found
  }
  return document.querySelector('[data-slot="composer-root"]')
}

function ensureStyle() {
  let style = document.getElementById('turn-usage-style')
  if (!style) {
    style = document.createElement('style')
    style.id = 'turn-usage-style'
    document.head.appendChild(style)
  }
  style.textContent = `
    @keyframes turn-usage-sweep {
      0% { background-position: 100% 0; }
      66.66% { background-position: 0% 0; }
      66.67%, 100% { background-position: 0% 0; }
    }
    [data-turn-usage-pulse="1"] {
      color: var(--ui-text-tertiary);
      background-image: linear-gradient(
        90deg,
        var(--ui-text-tertiary) 0%,
        var(--ui-text-tertiary) 42%,
        #fff 50%,
        var(--ui-text-tertiary) 58%,
        var(--ui-text-tertiary) 100%
      );
      background-size: 220% 100%;
      background-repeat: no-repeat;
      background-position: 100% 0;
      background-clip: text;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      animation: turn-usage-sweep 3s linear infinite;
    }
  `
}

function barBackground() {
  return 'color-mix(in srgb, var(--composer-fill, var(--dt-card)) 42%, transparent)'
}

function composerSurface() {
  const root = composerRoot()
  return root?.querySelector('[data-slot="composer-surface"]') || null
}

function ensureLiveBar() {
  const surface = composerSurface()
  if (!surface || !surface.parentElement) return null
  for (const stale of document.querySelectorAll(`[${LIVE_ATTR}]`)) {
    if (stale.parentElement !== surface.parentElement || stale.nextElementSibling !== surface) stale.remove()
  }
  let bar = surface.parentElement.querySelector(`[${LIVE_ATTR}]`)
  if (!bar) {
    bar = document.createElement('div')
    bar.setAttribute(LIVE_ATTR, '1')
    Object.assign(bar.style, {
      display: 'flex',
      alignItems: 'center',
      width: '100%',
      boxSizing: 'border-box',
      margin: '0',
      padding: '5px 10px',
      border: '1px solid var(--ui-stroke-secondary)',
      borderBottom: 'none',
      borderRadius: '12px 12px 0 0',
      background: barBackground(),
      backdropFilter: 'blur(0.75rem) saturate(1.12)',
      WebkitBackdropFilter: 'blur(0.75rem) saturate(1.12)',
      pointerEvents: 'auto',
      zIndex: '2'
    })
    const line = document.createElement('div')
    line.setAttribute('data-line', 'session')
    Object.assign(line.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-evenly',
      width: '100%',
      minWidth: 0,
      fontSize: '0.6875rem',
      lineHeight: '1rem',
      color: 'var(--ui-text-tertiary)',
      fontVariantNumeric: 'tabular-nums'
    })
    bar.appendChild(line)
    bar.addEventListener('click', () => {
      const text = [...line.querySelectorAll('[data-seg]')]
        .map(node => node.textContent)
        .filter(Boolean)
        .join('  ')
      if (!text) return
      haptic('tap')
      copyText(text)
    })
    surface.parentElement.insertBefore(bar, surface)
    surface.style.borderTopLeftRadius = '0'
    surface.style.borderTopRightRadius = '0'
  }
  bar.style.background = barBackground()
  bar.style.backdropFilter = 'blur(0.75rem) saturate(1.12)'
  bar.style.webkitBackdropFilter = 'blur(0.75rem) saturate(1.12)'
  const line = bar.querySelector('[data-line="session"]')
  if (line) line.style.justifyContent = 'space-evenly'
  return bar
}

function renderSegments(container, parts, { pulseFirst = false, tight = false } = {}) {
  if (!container) return
  const key = `${parts.join('\0')}|${pulseFirst ? 1 : 0}|${tight ? 1 : 0}`
  if (container.dataset.key === key) return
  container.dataset.key = key
  container.replaceChildren()
  parts.forEach((text, i) => {
    if (i) {
      const rule = document.createElement('span')
      rule.setAttribute('aria-hidden', 'true')
      Object.assign(rule.style, {
        width: '1px',
        alignSelf: tight ? 'center' : 'stretch',
        height: tight ? '10px' : '',
        margin: tight ? '0 6px' : '2px 4px',
        background: 'var(--ui-stroke-secondary)',
        opacity: '0.7',
        flexShrink: '0'
      })
      container.appendChild(rule)
    }
    const seg = document.createElement('span')
    seg.setAttribute('data-seg', '1')
    seg.textContent = text
    if (pulseFirst && i === 0) seg.setAttribute('data-turn-usage-pulse', '1')
    Object.assign(seg.style, {
      flex: '0 1 auto',
      minWidth: 0,
      textAlign: 'center',
      whiteSpace: 'nowrap',
      padding: tight ? '0 2px' : '0 4px',
      color: 'var(--ui-text-tertiary)'
    })
    container.appendChild(seg)
  })
}

function updateLivePanel(parts, running = false) {
  ensureStyle()
  const bar = ensureLiveBar()
  if (!bar) return
  const line = bar.querySelector('[data-line="session"]')
  renderSegments(line, Array.isArray(parts) ? parts : [String(parts || '')], { pulseFirst: running })
}

function startObserver() {
  if (observer || typeof MutationObserver === 'undefined') return
  observer = new MutationObserver(scheduleRehome)
  observer.observe(document.body, { childList: true, subtree: true })
}

function touchSessionClock(sessionId) {
  if (!sessionId) return
  const clock = $sessionClock.get()
  if (clock.sessionId === sessionId && clock.startedAt > 0) return
  $sessionClock.set({ sessionId, startedAt: Date.now() })
}

function billedOf(row) {
  return num(row?.prompt) || num(row?.input)
}

function deltaSnap(from, to) {
  const billed = Math.max(0, billedOf(to) - billedOf(from))
  const uncached = Math.max(0, num(to.input) - num(from.input))
  const output = Math.max(0, num(to.output) - num(from.output))
  const cache = Math.max(0, num(to.cache) - num(from.cache))
  const calls = Math.max(0, num(to.calls) - num(from.calls))
  const cacheWrite = Math.max(0, billed - uncached - cache)
  const costDelta =
    to.cost != null && from.cost != null
      ? Math.max(0, to.cost - from.cost)
      : estimateBuckets({ billed, uncached, cache, cacheWrite, output, calls: Math.max(1, calls) }, host.state.model.get())
  return {
    input: billed,
    prompt: billed,
    output,
    cache,
    calls,
    cost: costDelta,
    cacheHit: to.cacheHit
  }
}

function foldAcc(acc, delta) {
  return {
    input: num(acc.input) + num(delta.input),
    output: num(acc.output) + num(delta.output),
    cache: num(acc.cache) + num(delta.cache),
    calls: num(acc.calls) + num(delta.calls),
    cost: num(acc.cost) + num(delta.cost),
    apiSec: num(acc.apiSec)
  }
}

function noteUsage(usage, sessionId) {
  const now = snapUsage(usage)
  const live = $live.get()
  if (!live.running || (sessionId && live.sessionId && live.sessionId !== sessionId)) return now
  const baseline = live.prev || live.snap || emptySnap()
  const delta = deltaSnap(baseline, now)
  if (!delta.input && !delta.output && !delta.cache && !delta.calls) return now
  $live.set({
    ...live,
    prev: now,
    acc: foldAcc(live.acc || emptyAcc(), delta)
  })
  return now
}

function beginTurn(sessionId) {
  if (!sessionId) return
  touchSessionClock(sessionId)
  const live = $live.get()
  if (live.running && live.sessionId === sessionId && live.startedAt > 0) return
  const snap = snapUsage(host.state.focusedUsage.get())
  $live.set({
    running: true,
    sessionId,
    startedAt: live.running && live.startedAt > 0 ? live.startedAt : Date.now(),
    snap: live.running && live.snap ? live.snap : snap,
    prev: live.running && live.prev ? live.prev : snap,
    acc: live.running && live.acc ? live.acc : emptyAcc()
  })
}

function finishTurn(sessionId) {
  const live = $live.get()
  if (!live.running) return
  if (live.sessionId && sessionId && live.sessionId !== sessionId) return
  const startedAt = live.startedAt > 0 ? live.startedAt : Date.now()
  const now = Date.now()
  const current = noteUsage(host.state.focusedUsage.get(), live.sessionId || sessionId)
  const latest = $live.get()
  const acc = latest.acc || emptyAcc()
  const usedAcc = acc.input || acc.output || acc.cache || acc.calls
  const fallback = deltaSnap(live.snap || emptySnap(), current)
  const input = usedAcc ? acc.input : fallback.input
  const output = usedAcc ? acc.output : fallback.output
  const cache = usedAcc ? acc.cache : fallback.cache
  const calls = usedAcc ? acc.calls : fallback.calls
  const cost = usedAcc && acc.cost > 0 ? acc.cost : fallback.cost
  const billed = input
  const found = lastSettledAssistant(anchorEl)
  const row = {
    id: `${live.sessionId || sessionId || 'turn'}-${startedAt}`,
    sessionId: live.sessionId || sessionId,
    durationSec: Math.max(0, (now - startedAt) / 1000),
    messageId: messageKey(found.root),
    rootIndex: found.index,
    model: host.state.model.get(),
    effort: $effort.get(),
    input: billed,
    prompt: billed,
    output,
    cache,
    calls,
    cost,
    cacheHit: billed > 0 ? (cache / billed) * 100 : current.cacheHit
  }
  $live.set({
    running: false,
    sessionId: null,
    startedAt: 0,
    snap: emptySnap(),
    prev: emptySnap(),
    acc: emptyAcc()
  })
  $lastTurn.set(row)
  addDaily(resolveCost(row, row.model))
  pushCompleted(row)
  if (found.root) ensureBadge(found.root, row)
  else scheduleRehome()
}

function sessionRow(usage, elapsed) {
  const current = snapUsage(usage)
  return {
    durationSec: elapsed,
    input: current.input,
    prompt: current.prompt,
    output: current.output,
    total: current.total,
    cache: current.cache,
    cacheHit: current.cacheHit,
    calls: current.calls,
    cost: current.cost
  }
}

function turnFromAcc(acc, elapsed, cacheHit) {
  const input = num(acc.input)
  return {
    durationSec: elapsed,
    input,
    prompt: input,
    output: num(acc.output),
    cache: num(acc.cache),
    calls: num(acc.calls),
    cacheHit: input > 0 ? (num(acc.cache) / input) * 100 : cacheHit,
    cost: num(acc.cost) || null
  }
}

function turnRow(usage, live, elapsed) {
  const acc = live.acc || emptyAcc()
  if (acc.input || acc.output || acc.cache || acc.calls) return turnFromAcc(acc, elapsed, live.prev?.cacheHit)
  const current = snapUsage(usage)
  const d = deltaSnap(live.snap || emptySnap(), current)
  return {
    durationSec: elapsed,
    input: d.input,
    prompt: d.prompt,
    output: d.output,
    cache: d.cache,
    calls: d.calls,
    cacheHit: d.input > 0 ? (d.cache / d.input) * 100 : current.cacheHit,
    cost: d.cost
  }
}

function useElapsed(active, startedAt) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || !startedAt) return undefined
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [active, startedAt])
  return active && startedAt ? (now - startedAt) / 1000 : 0
}

function Anchor() {
  const sessionId = useValue(host.state.focusedSessionId)
  const live = useValue($live)
  const usage = useValue(host.state.focusedUsage)
  const model = useValue(host.state.model)
  const effort = useValue($effort)
  const lastTurn = useValue($lastTurn)
  const daily = useValue($daily)
  const running = Boolean(live.running && live.sessionId === sessionId)

  useEffect(() => {
    if (sessionId) touchSessionClock(sessionId)
  }, [sessionId])

  useEffect(() => {
    const session = sessionRow(usage, 0)
    const turn = running
      ? turnRow(usage, live, 0)
      : lastTurn && lastTurn.sessionId === sessionId
        ? lastTurn
        : { input: 0, output: 0, total: 0, cacheHit: session.cacheHit, cost: 0 }
    const inProgress = running ? resolveCost(turn, model) : 0
    updateLivePanel(
      sessionBarParts(turn, session, {
        model,
        effort,
        today: dailyUsd() + num(inProgress)
      }),
      running
    )
  }, [running, usage, live, model, effort, lastTurn, daily, sessionId])

  useEffect(() => {
    scheduleRehome()
  }, [sessionId])

  return jsx('span', {
    ref: node => {
      anchorEl = node
    },
    'aria-hidden': 'true',
    style: { display: 'none' }
  })
}

function rememberEffort(value) {
  if (typeof value !== 'string') return
  const next = value.trim()
  if (next && next !== $effort.get()) $effort.set(next)
}

function bindEvents(ctx) {
  startObserver()
  const unsubs = []
  unsubs.push(
    watchAtom(host.state.busy, busy => {
      const sessionId = host.state.focusedSessionId.get()
      if (busy) {
        if (finishTimer) {
          clearTimeout(finishTimer)
          finishTimer = null
        }
        beginTurn(sessionId)
        return
      }
      if (!$live.get().running) return
      if (finishTimer) clearTimeout(finishTimer)
      finishTimer = setTimeout(() => {
        finishTimer = null
        if (!host.state.busy.get()) finishTurn($live.get().sessionId || sessionId)
      }, 450)
    })
  )
  unsubs.push(
    watchAtom(host.state.focusedUsage, usage => {
      noteUsage(usage, host.state.focusedSessionId.get())
    })
  )
  unsubs.push(
    host.onEvent('session.info', event => {
      const payload = event?.payload || {}
      rememberEffort(payload.reasoning_effort)
    })
  )
  const sessionId = host.state.focusedSessionId.get()
  if (sessionId) {
    void host
      .request('session.info', { session_id: sessionId })
      .then(info => rememberEffort(info?.reasoning_effort))
      .catch(() => undefined)
  }
  if (typeof ctx.onDispose === 'function') {
    ctx.onDispose(() => {
      unsubs.forEach(fn => {
        try {
          fn()
        } catch {
          /* ignore */
        }
      })
      if (finishTimer) clearTimeout(finishTimer)
      if (rehomeTimer) clearTimeout(rehomeTimer)
      observer?.disconnect()
      observer = null
      document.querySelectorAll(`[${LIVE_ATTR}]`).forEach(node => node.remove())
    })
  }
}

export default {
  id: ID,
  name: 'Turn Usage',
  description: 'Centered session totals above the composer; per-turn badge under each completed reply.',
  register(ctx) {
    writeClipboard = ctx.os?.writeClipboard || null
    pluginStorage = ctx.storage
    ensureStyle()
    void loadRemotePrices()
    if (typeof ctx.storage?.get === 'function') {
      void Promise.resolve(ctx.storage.get(STORAGE_KEY))
        .then(saved => {
          if (saved && typeof saved === 'object') $completed.set(saved)
        })
        .catch(() => undefined)
      void Promise.resolve(ctx.storage.get(DAILY_KEY))
        .then(saved => {
          if (saved && typeof saved === 'object' && saved.date) $daily.set(saved)
        })
        .catch(() => undefined)
    }
    bindEvents(ctx)
    ctx.register({
      id: 'anchor',
      area: COMPOSER_AREAS.top,
      order: 10,
      render: Anchor
    })
  }
}
