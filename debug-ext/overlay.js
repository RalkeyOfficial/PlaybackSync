// Isolated content-script world. Shares the page DOM but not its JS globals.
// Draws an on-page adapter-development panel so streaming-site players can be
// inspected WITHOUT opening devtools (devtools itself can perturb lazy mounts).
//
// It runs in every frame. The TOP frame draws the panel; every SUBFRAME (e.g.
// the cross-origin strm.cx embed) runs a headless probe that evaluates the same
// selectors + video state in its own document and reports up to the top frame
// via postMessage — and accepts playback-control / selector-list messages back
// down. That's how the panel shows, and drives, a `<video>` it can't reach
// directly across the cross-origin boundary.
//
// PERFORMANCE: the MutationObserver callback stays O(1) (bump a counter, mark
// dirty). All scanning/rendering happens on a fixed 300ms scheduler, so churn
// during hydration can't freeze the page.

(() => {
  const FROM_FRAME = 'pbsync-dbg-frame' // subframe -> top
  const TO_FRAME_CTL = 'pbsync-dbg-ctl' // top -> subframe: playback control
  const TO_FRAME_SEL = 'pbsync-dbg-sel' // top -> subframe: custom selector list
  const MAIN_CHANNEL = 'pbsync-dbg' // main-world.js -> this frame (attachShadow)
  const REFRESH_MS = 300
  const MAX_LOG = 300
  const STORE_KEY = 'pbsyncDbg.state.v2'
  const IN_TOP = window === window.top

  // Selectors PlaybackSync's adapters (and likely future ones) care about.
  // Grouped for display; the flat list is what every frame evaluates.
  const DEFAULT_GROUPS = [
    {
      group: 'Page (miruro)',
      items: [
        { sel: '#app', note: 'SPA root' },
        { sel: 'strmcx-embed', note: 'player embed host (open shadow)' },
        { sel: '#player-container', note: 'player container' },
        { sel: '#episodes-list-container', note: 'episode list (catalog)' },
        { sel: 'button[data-episode-id]', note: 'episode entries' },
      ],
    },
    {
      group: 'Video / player',
      items: [
        { sel: 'video', note: 'the media element' },
        { sel: 'media-player', note: 'Vidstack player' },
        { sel: 'media-provider', note: 'Vidstack provider' },
        { sel: 'media-provider video', note: 'scoped video (same shadow root)' },
        { sel: 'strmcx-player', note: 'strmcx wrapper' },
      ],
    },
    {
      group: 'Controls / frames',
      items: [
        { sel: '#player-container .vds-video-layout button', note: 'cold-start load button' },
        { sel: 'iframe', note: 'iframes (embeds / ads)' },
      ],
    },
  ]
  const DEFAULT_SELECTORS = DEFAULT_GROUPS.flatMap((g) => g.items.map((i) => i.sel))

  const READY_STATE = ['0 nothing', '1 metadata', '2 current', '3 future', '4 enough']
  const NET_STATE = ['0 empty', '1 idle', '2 loading', '3 no-source']

  const start = performance.now()
  const now = () => Math.round(performance.now() - start)

  // ---- persisted UI state ------------------------------------------------

  const state = loadState()
  function loadState() {
    const base = { custom: [], collapsed: {}, pos: null }
    try {
      const raw = localStorage.getItem(STORE_KEY)
      if (raw) return { ...base, ...JSON.parse(raw) }
    } catch { /* ignore */ }
    return base
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)) } catch { /* ignore */ }
  }

  function customSelectors() { return state.custom.slice() }
  function allSelectors() { return [...DEFAULT_SELECTORS, ...customSelectors()] }

  // ---- deep DOM helpers (pierce OPEN shadow roots) -----------------------
  // Only called from the 300ms scheduler / the frame probe tick — never per
  // mutation. Closed roots aren't pierced; the strm.cx video is light DOM in
  // its own frame, and the embed host uses an open root.

  /**
   * One traversal that returns the document plus every open shadow root in it.
   * Selector counting then runs a cheap `querySelectorAll` on each — far
   * cheaper than a fresh deep walk per selector.
   *
   * @param {ParentNode} root Subtree to start from. Defaults to `document`.
   * @param {Array} acc Accumulator (internal).
   * @returns {Array<ParentNode>} document + all open shadow roots.
   */
  function collectRoots(root = document, acc = []) {
    acc.push(root)
    const all = root.querySelectorAll ? root.querySelectorAll('*') : []
    for (const el of all) if (el.shadowRoot) collectRoots(el.shadowRoot, acc)
    return acc
  }

  /**
   * Count elements matching `selector` across the light DOM + open shadow roots.
   *
   * @param {string} selector CSS selector.
   * @param {Array<ParentNode>} roots Result of {@link collectRoots}.
   * @returns {number} Total matches (each element counted once).
   */
  function countIn(selector, roots) {
    let n = 0
    for (const r of roots) {
      try { n += r.querySelectorAll(selector).length } catch { /* bad selector */ }
    }
    return n
  }

  /**
   * First `<video>` anywhere in the composed tree of `roots`.
   *
   * @param {Array<ParentNode>} roots Result of {@link collectRoots}.
   * @returns {HTMLVideoElement|null}
   */
  function findVideoIn(roots) {
    for (const r of roots) {
      const v = r.querySelector && r.querySelector('video')
      if (v) return v
    }
    return null
  }

  /**
   * Read the interesting bits of a `<video>` into a plain object (postMessage-
   * cloneable, so a subframe can ship it to the top frame).
   *
   * @param {HTMLVideoElement} v The element.
   * @returns {object} Snapshot.
   */
  function videoSnapshot(v) {
    let buffered = 0
    try { if (v.buffered && v.buffered.length) buffered = v.buffered.end(v.buffered.length - 1) } catch { /* ignore */ }
    return {
      src: v.currentSrc || '',
      currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : 0,
      paused: v.paused, ended: v.ended, muted: v.muted,
      readyState: v.readyState, networkState: v.networkState,
      playbackRate: v.playbackRate, buffered,
      width: v.videoWidth, height: v.videoHeight,
    }
  }

  const fmtTime = (s) => {
    if (!Number.isFinite(s)) return '–'
    const m = Math.floor(s / 60), sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }
  const hostOf = (href) => { try { return new URL(href).host } catch { return href } }

  function applyControl(v, action, value) {
    if (!v) return
    try {
      if (action === 'play') v.play()
      else if (action === 'pause') v.pause()
      else if (action === 'seekBy') v.currentTime = Math.max(0, v.currentTime + value)
      else if (action === 'seekTo') v.currentTime = value
      else if (action === 'rate') v.playbackRate = value
    } catch { /* ignore */ }
  }

  // ===================================================================== //
  //  SUBFRAME PROBE (no panel) — report up, accept control/selectors down  //
  // ===================================================================== //

  function runFrameProbe() {
    let selectors = allSelectors()
    let wiredVideo = null
    let lastKey = ''

    const post = (extra) => {
      try { window.top.postMessage({ source: FROM_FRAME, href: location.href, ...extra }, '*') } catch { /* parent gone */ }
    }

    const wireVideoEvents = (v) => {
      if (v === wiredVideo) return
      wiredVideo = v
      if (!v) return
      for (const ev of ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'loadedmetadata', 'waiting', 'ended', 'emptied']) {
        v.addEventListener(ev, () => post({ kind: 'event', event: ev }), { passive: true })
      }
    }

    const scan = () => {
      const roots = collectRoots()
      const v = findVideoIn(roots)
      wireVideoEvents(v)
      const counts = {}
      for (const sel of selectors) counts[sel] = countIn(sel, roots)
      const status = {
        kind: 'status',
        host: location.host,
        hasVideo: !!v,
        video: v ? videoSnapshot(v) : null,
        counts,
      }
      const key = JSON.stringify(status)
      if (key === lastKey) return
      lastKey = key
      post(status)
    }

    window.addEventListener('message', (e) => {
      if (e.source !== window.top) return
      const d = e.data
      if (!d) return
      if (d.source === TO_FRAME_CTL) {
        applyControl(findVideoIn(collectRoots()), d.action, d.value)
        lastKey = '' // force a fresh report so the panel updates immediately
      } else if (d.source === TO_FRAME_SEL) {
        selectors = [...DEFAULT_SELECTORS, ...(Array.isArray(d.custom) ? d.custom : [])]
        lastKey = ''
      }
    })

    scan()
    setInterval(scan, 400)
  }

  if (!IN_TOP) {
    if (document.body) runFrameProbe()
    else document.addEventListener('DOMContentLoaded', () => runFrameProbe(), { once: true })
    return
  }

  // ===================================================================== //
  //  TOP FRAME — the panel                                                 //
  // ===================================================================== //

  const log = []
  let ticks = 0
  // Latest report per subframe href → { host, hasVideo, video, counts, window }.
  const frames = new Map()
  let topWiredVideo = null

  function addLog(msg) {
    log.push(`[+${now()}ms] ${msg}`)
    if (log.length > MAX_LOG) log.shift()
    if (els.log) { els.log.textContent = log.join('\n'); els.log.scrollTop = els.log.scrollHeight }
  }

  // ---- panel skeleton (built once; dynamic bits updated each tick) -------

  const els = {}

  function mount() {
    if (document.getElementById('pbsync-dbg-panel')) return
    const panel = document.createElement('div')
    panel.id = 'pbsync-dbg-panel'
    panel.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'width:380px', 'max-height:88vh',
      'display:flex', 'flex-direction:column', 'background:rgba(10,12,16,0.95)',
      'color:#d6ffd6', 'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'border:1px solid #2b6', 'border-radius:8px', 'box-shadow:0 8px 30px rgba(0,0,0,0.6)',
      'overflow:hidden',
    ].join(';')
    if (state.pos) { panel.style.left = state.pos.left; panel.style.top = state.pos.top }
    else { panel.style.left = '8px'; panel.style.top = '8px' }

    const header = document.createElement('div')
    header.textContent = 'PlaybackSync debug ▤'
    header.style.cssText = 'cursor:move;padding:6px 9px;background:#12351c;color:#9f9;font-weight:600;user-select:none;flex:0 0 auto'
    makeDraggable(panel, header)

    const body = document.createElement('div')
    body.style.cssText = 'overflow:auto;display:flex;flex-direction:column'

    els.summary = mkSection(body, 'Summary', 'summary').body
    els.frames = mkSection(body, 'Frames', 'frames').body
    els.selectors = mkSection(body, 'Selectors', 'selectors').body
    buildSelectorControls(els.selectors)
    els.selRows = document.createElement('div'); els.selectors.appendChild(els.selRows)
    els.video = mkSection(body, 'Video state', 'video').body
    els.controls = mkSection(body, 'Playback controls', 'controls').body
    buildControls(els.controls)
    els.advanced = mkSection(body, 'Advanced', 'advanced', true).body
    buildAdvanced(els.advanced)
    const logSec = mkSection(body, 'Log', 'log')
    els.log = document.createElement('pre')
    els.log.style.cssText = 'margin:0;white-space:pre-wrap;color:#bcd;max-height:180px;overflow:auto'
    logSec.body.appendChild(els.log)

    panel.append(header, body)
    document.body.appendChild(panel)
    els.panel = panel
    renderSelectorRows()
  }

  function mkSection(parent, title, key, defaultCollapsed = false) {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'border-top:1px solid #223'
    const head = document.createElement('div')
    head.style.cssText = 'padding:4px 9px;background:#0e1a12;color:#8db;cursor:pointer;user-select:none;font-weight:600'
    const body = document.createElement('div')
    body.style.cssText = 'padding:6px 9px'
    const collapsed = key in state.collapsed ? state.collapsed[key] : defaultCollapsed
    body.style.display = collapsed ? 'none' : 'block'
    const caret = () => (body.style.display === 'none' ? '▸' : '▾')
    head.textContent = `${caret()} ${title}`
    head.addEventListener('click', () => {
      body.style.display = body.style.display === 'none' ? 'block' : 'none'
      state.collapsed[key] = body.style.display === 'none'
      saveState()
      head.textContent = `${caret()} ${title}`
    })
    wrap.append(head, body)
    parent.appendChild(wrap)
    return { body, head }
  }

  function makeDraggable(panel, handle) {
    let dx = 0, dy = 0, dragging = false
    handle.addEventListener('mousedown', (e) => { dragging = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; e.preventDefault() })
    window.addEventListener('mousemove', (e) => { if (!dragging) return; panel.style.left = `${e.clientX - dx}px`; panel.style.top = `${e.clientY - dy}px` })
    window.addEventListener('mouseup', () => {
      if (!dragging) return
      dragging = false
      state.pos = { left: panel.style.left, top: panel.style.top }
      saveState()
    })
  }

  const btn = (label, fn, title) => {
    const b = document.createElement('button')
    b.textContent = label
    if (title) b.title = title
    b.style.cssText = 'padding:3px 7px;background:#1b3a4b;color:#cfe;border:1px solid #37607a;border-radius:4px;cursor:pointer;font:inherit'
    b.addEventListener('click', (e) => { e.stopPropagation(); fn() })
    return b
  }
  const row = () => { const d = document.createElement('div'); d.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:2px 0'; return d }

  // ---- selectors watchboard ---------------------------------------------

  function buildSelectorControls(container) {
    const r = row()
    const input = document.createElement('input')
    input.placeholder = 'add a selector…'
    input.style.cssText = 'flex:1 1 auto;min-width:120px;padding:3px 6px;background:#0b1016;color:#cfe;border:1px solid #37607a;border-radius:4px;font:inherit'
    const add = () => {
      const sel = input.value.trim()
      if (!sel || state.custom.includes(sel)) { input.value = ''; return }
      state.custom.push(sel); saveState(); input.value = ''
      renderSelectorRows(); pushSelectorsToFrames()
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); add() } })
    r.append(input, btn('+ add', add))
    container.appendChild(r)
  }

  // Map selector string → { countTop, countCells: Map(host->span) } refreshed each tick.
  const selBadges = new Map()

  function renderSelectorRows() {
    els.selRows.textContent = ''
    selBadges.clear()
    const groups = [...DEFAULT_GROUPS]
    if (state.custom.length) groups.push({ group: 'Custom', items: state.custom.map((sel) => ({ sel, note: '', custom: true })) })
    for (const g of groups) {
      const gh = document.createElement('div')
      gh.textContent = g.group
      gh.style.cssText = 'color:#7a9;margin:4px 0 2px;font-weight:600'
      els.selRows.appendChild(gh)
      for (const item of g.items) {
        const line = document.createElement('div')
        line.style.cssText = 'display:flex;align-items:center;gap:6px;padding:1px 0;cursor:pointer'
        line.title = item.note || ''
        const badge = document.createElement('span')
        badge.style.cssText = 'flex:0 0 auto;width:74px;text-align:right;font-variant-numeric:tabular-nums'
        const label = document.createElement('span')
        label.textContent = item.sel
        label.style.cssText = 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cde'
        line.append(badge, label)
        if (item.custom) {
          line.appendChild(btn('×', () => {
            state.custom = state.custom.filter((s) => s !== item.sel); saveState()
            renderSelectorRows(); pushSelectorsToFrames()
          }, 'remove'))
        }
        line.addEventListener('click', () => highlightSelector(item.sel))
        els.selRows.appendChild(line)
        selBadges.set(item.sel, badge)
      }
    }
    updateSelectorBadges()
  }

  function updateSelectorBadges(topRoots) {
    const roots = topRoots || collectRoots()
    for (const [sel, badge] of selBadges) {
      const top = countIn(sel, roots)
      const perFrame = []
      for (const f of frames.values()) {
        const c = f.counts ? f.counts[sel] : undefined
        if (c) perFrame.push(`${shortHost(f.host)}:${c}`)
      }
      const total = top + perFrame.reduce((n, s) => n + Number(s.split(':')[1]), 0)
      const parts = []
      if (top) parts.push(`top:${top}`)
      parts.push(...perFrame)
      badge.textContent = parts.length ? parts.join(' ') : '—'
      badge.style.color = total ? '#8f8' : '#e77'
    }
  }
  const shortHost = (h) => (h ? h.replace(/^www\./, '').split('.')[0] : '?')

  function highlightSelector(sel) {
    const roots = collectRoots()
    for (const r of roots) {
      const el = r.querySelector && r.querySelector(sel)
      if (el) {
        const prev = el.style.outline
        el.style.outline = '3px solid #ff4'
        el.scrollIntoView({ block: 'center' })
        setTimeout(() => { el.style.outline = prev }, 1500)
        addLog(`highlight ${sel} → ${describePath(el)}`)
        return
      }
    }
    const inFrame = [...frames.values()].find((f) => f.counts && f.counts[sel])
    addLog(inFrame ? `"${sel}" not in top; ${inFrame.counts[sel]}× in ${inFrame.host} (can't outline cross-origin)` : `"${sel}" matched nowhere`)
  }

  // ---- playback controls (act locally or relay to the media frame) -------

  function primaryVideo() {
    const local = findVideoIn(collectRoots())
    if (local) return { kind: 'local', el: local }
    for (const f of frames.values()) if (f.hasVideo) return { kind: 'frame', frame: f }
    return null
  }

  function control(action, value) {
    const p = primaryVideo()
    if (!p) { addLog(`control ${action}: no video anywhere`); return }
    if (p.kind === 'local') { applyControl(p.el, action, value); addLog(`control ${action}${value != null ? ' ' + value : ''} → top`) }
    else {
      try { p.frame.window.postMessage({ source: TO_FRAME_CTL, action, value }, '*'); addLog(`control ${action}${value != null ? ' ' + value : ''} → ${p.frame.host}`) } catch { addLog('control relay failed (frame gone)') }
    }
  }

  function buildControls(container) {
    const r1 = row()
    r1.append(
      btn('▶ play', () => control('play')),
      btn('⏸ pause', () => control('pause')),
      btn('⏮ 0:00', () => control('seekTo', 0)),
      btn('-10s', () => control('seekBy', -10)),
      btn('+10s', () => control('seekBy', 10)),
    )
    const r2 = row()
    for (const rate of [0.5, 1, 1.5, 2]) r2.append(btn(`${rate}×`, () => control('rate', rate)))
    container.append(r1, r2)
  }

  // ---- advanced diagnostics ---------------------------------------------

  function buildAdvanced(container) {
    const r = row()
    r.append(
      btn('scroll into view', scrollPlayerIntoView, 'scroll the player container into view (tests IntersectionObserver mounts)'),
      btn('force eager', forceEager, 'set load=eager on Vidstack media-player/provider'),
      btn('press space', pressSpaceOnLoadButton, 'synthesize Space keydown/keyup on the cold-start load button'),
      btn('inspect embed', inspectEmbed, 'dump strmcx-embed shadow contents + iframe srcs'),
      btn('deep scan', deepScanVideo, 'log the composed path to the first <video>'),
    )
    const r2 = row()
    r2.append(
      btn('copy report', copyReport, 'copy a full snapshot (frames + selectors + video)'),
      btn('copy log', copyLog),
      btn('clear log', () => { log.length = 0; if (els.log) els.log.textContent = '' }),
    )
    container.append(r, r2)
  }

  const PLAYER_CONTAINERS = ['#player-container', 'strmcx-player', 'strmcx-embed', '#app']
  function scrollPlayerIntoView() {
    const roots = collectRoots()
    for (const sel of PLAYER_CONTAINERS) {
      for (const r of roots) {
        const el = r.querySelector && r.querySelector(sel)
        if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'center' }); addLog(`scrollIntoView(${sel})`); return }
      }
    }
    addLog('scrollIntoView: no container found')
  }
  function forceEager() {
    const roots = collectRoots()
    let n = 0
    for (const tag of ['media-player', 'media-provider']) {
      for (const r of roots) for (const el of (r.querySelectorAll ? r.querySelectorAll(tag) : [])) { el.setAttribute('load', 'eager'); el.setAttribute('posterLoad', 'eager'); n++ }
    }
    const v = findVideoIn(roots); if (v && v.load) try { v.load() } catch { /* ignore */ }
    addLog(`forceEager: set load=eager on ${n} element(s)`)
  }
  function pressSpaceOnLoadButton() {
    const roots = collectRoots()
    let btnEl = null
    for (const r of roots) { const b = r.querySelector && r.querySelector('#player-container .vds-video-layout button'); if (b) { btnEl = b; break } }
    if (!btnEl) { addLog('space: no load button found'); return }
    btnEl.focus()
    const init = { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true }
    btnEl.dispatchEvent(new KeyboardEvent('keydown', init)); btnEl.dispatchEvent(new KeyboardEvent('keyup', init))
    addLog('space: dispatched keydown/keyup on load button')
  }
  function inspectEmbed() {
    const roots = collectRoots()
    let embed = null
    for (const r of roots) { const e = r.querySelector && r.querySelector('strmcx-embed'); if (e) { embed = e; break } }
    if (!embed) { addLog('inspectEmbed: no strmcx-embed'); return }
    const lines = [`inspectEmbed: <strmcx-embed> shadow=${embed.shadowRoot ? 'open' : 'none'}`]
    if (embed.shadowRoot) lines.push(...outline(embed.shadowRoot, 3))
    for (const r of roots) for (const f of (r.querySelectorAll ? r.querySelectorAll('iframe') : [])) {
      let access
      try { access = f.contentDocument ? 'same-origin' : 'cross-origin (blocked)' } catch { access = 'cross-origin (blocked)' }
      lines.push(` iframe src=${f.getAttribute('src') || '(none)'} → ${access}`)
    }
    addLog(lines.join('\n'))
  }
  function outline(root, depth, indent = '  ') {
    const out = []
    const kids = root.children ? Array.from(root.children) : []
    for (const el of kids.slice(0, 12)) {
      let label = el.tagName.toLowerCase()
      if (el.id) label += `#${el.id}`
      if (el.tagName === 'IFRAME') label += ` src=${el.getAttribute('src') || '(none)'}`
      if (el.shadowRoot) label += ' {shadow}'
      out.push(indent + label)
      if (depth > 1) out.push(...outline(el.shadowRoot || el, depth - 1, indent + '  '))
    }
    if (kids.length > 12) out.push(`${indent}… +${kids.length - 12} more`)
    return out
  }
  function deepScanVideo() {
    const v = findVideoIn(collectRoots())
    addLog(v ? `deepScan: ${describePath(v)}` : 'deepScan: no <video> in top frame (check Frames for subframe videos)')
  }
  function describePath(el) {
    const parts = []
    let node = el
    while (node) {
      let label = node.tagName ? node.tagName.toLowerCase() : String(node.nodeName)
      if (node.id) label += `#${node.id}`
      parts.unshift(label)
      const parent = node.parentElement
      if (parent) node = parent
      else { const r = node.getRootNode && node.getRootNode(); if (r && r.host) { parts.unshift('>>'); node = r.host } else node = null }
    }
    return parts.join(' ')
  }

  function copyText(text, what) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => addLog(`${what} copied`), () => addLog('clipboard write failed'))
    else addLog('clipboard API unavailable')
  }
  function copyLog() { copyText(log.join('\n'), 'log') }
  function copyReport() {
    const roots = collectRoots()
    const lines = [`# PlaybackSync debug report`, `url: ${location.href}`, `frames: ${frames.size + 1} (top + ${frames.size} sub)`, '', '## selectors']
    for (const sel of allSelectors()) {
      const top = countIn(sel, roots)
      const fr = [...frames.values()].filter((f) => f.counts && f.counts[sel]).map((f) => `${shortHost(f.host)}:${f.counts[sel]}`)
      lines.push(`  ${top ? `top:${top} ` : ''}${fr.join(' ')}  ${sel}`)
    }
    lines.push('', '## frames')
    lines.push(`  top ${location.host} video=${findVideoIn(roots) ? 'yes' : 'no'}`)
    for (const f of frames.values()) lines.push(`  sub ${f.host} video=${f.hasVideo ? 'yes' : 'no'}${f.video ? ` rs=${f.video.readyState} t=${fmtTime(f.video.currentTime)} paused=${f.video.paused}` : ''}`)
    copyText(lines.join('\n'), 'report')
  }

  // ---- dynamic renders (each tick) --------------------------------------

  function primarySnapshot() {
    const local = findVideoIn(collectRoots())
    if (local) return { where: `top (${location.host})`, snap: videoSnapshot(local) }
    for (const f of frames.values()) if (f.hasVideo && f.video) return { where: `${f.host}`, snap: f.video }
    return null
  }

  function renderSummary() {
    const roots = collectRoots()
    const topVideo = findVideoIn(roots)
    const frameWithVideo = [...frames.values()].find((f) => f.hasVideo)
    const embed = countIn('strmcx-embed', roots)
    els.summary.textContent = [
      `url:     ${location.host}${location.pathname}${location.search}`,
      `ticks:   ${ticks}    elapsed: ${now()}ms`,
      `frames:  1 top + ${frames.size} sub    iframes(top): ${countIn('iframe', roots)}`,
      `embed:   ${embed ? 'strmcx-embed present' : 'no strmcx-embed'}`,
      `video:   ${topVideo ? 'in TOP frame' : frameWithVideo ? `in ${frameWithVideo.host}` : 'not found'}`,
    ].join('\n')
  }

  function renderFrames() {
    const roots = collectRoots()
    const lines = [`▸ top  ${location.host}  video=${findVideoIn(roots) ? 'YES' : 'no'}`]
    for (const f of frames.values()) {
      lines.push(`▸ sub  ${f.host}  video=${f.hasVideo ? 'YES' : 'no'}${f.video ? `  rs=${f.video.readyState}` : ''}`)
    }
    els.frames.textContent = lines.join('\n')
  }

  function renderVideo() {
    const p = primarySnapshot()
    if (!p) { els.video.textContent = 'no <video> found in any frame'; return }
    const s = p.snap
    const pct = s.duration ? Math.round((s.currentTime / s.duration) * 100) : 0
    const bufPct = s.duration ? Math.round((s.buffered / s.duration) * 100) : 0
    els.video.textContent = [
      `where:   ${p.where}`,
      `src:     ${s.src ? s.src.slice(0, 46) + (s.src.length > 46 ? '…' : '') : '(empty)'}`,
      `time:    ${fmtTime(s.currentTime)} / ${fmtTime(s.duration)}  (${pct}%)   buffered ${bufPct}%`,
      `state:   ${s.paused ? 'PAUSED' : 'PLAYING'}${s.ended ? ' (ended)' : ''}  rate ${s.playbackRate}×  ${s.muted ? 'muted' : ''}`,
      `ready:   ${READY_STATE[s.readyState] || s.readyState}   net ${NET_STATE[s.networkState] || s.networkState}`,
      `size:    ${s.width}×${s.height}`,
    ].join('\n')
  }

  function wireTopVideoEvents() {
    const v = findVideoIn(collectRoots())
    if (v === topWiredVideo) return
    topWiredVideo = v
    if (!v) return
    for (const ev of ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'loadedmetadata', 'waiting', 'ended']) {
      v.addEventListener(ev, () => addLog(`top: ${ev}`), { passive: true })
    }
  }

  // ---- inbound messages --------------------------------------------------

  window.addEventListener('message', (e) => {
    const d = e.data
    if (!d) return
    if (d.source === FROM_FRAME) {
      if (d.kind === 'event') { addLog(`${hostOf(d.href) || d.host}: ${d.event}`); return }
      const prev = frames.get(d.href)
      frames.set(d.href, { host: d.host || hostOf(d.href), href: d.href, hasVideo: d.hasVideo, video: d.video, counts: d.counts, window: e.source })
      if (!prev || prev.hasVideo !== d.hasVideo) addLog(`frame ${d.host || hostOf(d.href)}: video=${d.hasVideo ? 'YES' : 'no'}`)
      // A newly-seen frame needs the current custom selector list.
      if (!prev && state.custom.length) { try { e.source.postMessage({ source: TO_FRAME_SEL, custom: state.custom }, '*') } catch { /* ignore */ } }
      return
    }
    if (e.source === window && d.source === MAIN_CHANNEL) {
      if (d.type === 'ready') addLog('main-world hook installed')
      else if (d.type === 'attachShadow') addLog(`attachShadow <${d.tag}${d.id ? '#' + d.id : ''}> mode=${d.mode}`)
    }
  })

  function pushSelectorsToFrames() {
    for (const f of frames.values()) {
      try { f.window.postMessage({ source: TO_FRAME_SEL, custom: state.custom }, '*') } catch { /* ignore */ }
    }
  }

  // ---- boot --------------------------------------------------------------

  function boot() {
    mount()
    new MutationObserver((records) => { ticks += records.length }).observe(document.documentElement, { childList: true, subtree: true })
    setInterval(() => {
      // The heavy work, coalesced. Video-state + frame reports also refresh on a
      // steady beat even when the DOM is idle, so live playback keeps updating.
      const roots = collectRoots()
      wireTopVideoEvents()
      renderSummary()
      renderFrames()
      updateSelectorBadges(roots)
      renderVideo()
    }, REFRESH_MS)
    addLog('panel booted')
  }

  if (document.body) boot()
  else document.addEventListener('DOMContentLoaded', boot, { once: true })
})()
