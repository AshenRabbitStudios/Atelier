/* ───────────────────────────────────────────────────────────────────────────
   Whiteboard — mermaid board renderer.
   Uses the vendored, offline mermaid bundle (vendor/mermaid.min.js → global
   `mermaid`). securityLevel:'strict'. Error-tolerant: a syntax error shows the
   error + raw source (still editable upstream), never corrupts the doc, never
   throws to the caller. Pan/zoom via wheel + drag on the SVG container. Export:
   copy source + download .svg.
   ─────────────────────────────────────────────────────────────────────────── */
;(function (root) {
  'use strict'

  var initialized = false
  var renderSeq = 0

  function ensureInit() {
    if (initialized) return typeof root.mermaid !== 'undefined'
    if (typeof root.mermaid === 'undefined') return false
    try {
      root.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'dark',
        fontFamily: 'var(--font, system-ui, sans-serif)'
      })
      initialized = true
      return true
    } catch (e) {
      return false
    }
  }

  // Read theme background to decide dark vs neutral; kept simple.
  function currentTheme() {
    try {
      var bg = getComputedStyle(document.body).backgroundColor || ''
      // crude luminance check
      var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg)
      if (m) {
        var lum = (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000
        return lum > 140 ? 'default' : 'dark'
      }
    } catch (e) {}
    return 'dark'
  }

  /* Render board.source into `host` (a container). Returns a Promise.
     `host` gets a pan/zoom viewport with the SVG (on success) or an error card. */
  function renderMermaid(host, board) {
    host.innerHTML = ''
    var source = (board && board.source) || ''
    var wrap = document.createElement('div')
    wrap.className = 'wb-mermaid-viewport'
    host.appendChild(wrap)

    var toolbar = document.createElement('div')
    toolbar.className = 'wb-mermaid-toolbar'
    host.appendChild(toolbar)

    var seq = ++renderSeq
    var id = 'wb-mmd-' + Date.now() + '-' + seq

    if (!source.trim()) {
      wrap.innerHTML =
        '<div class="wb-empty">Empty mermaid board — add source in the editor below.</div>'
      return Promise.resolve()
    }
    if (!ensureInit()) {
      showError(wrap, 'mermaid renderer unavailable (vendored bundle not loaded)', source)
      return Promise.resolve()
    }

    // set theme per current host colors
    try {
      root.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: currentTheme()
      })
    } catch (e) {}

    return root.mermaid
      .render(id, source)
      .then(function (out) {
        if (seq !== renderSeq) return // a newer render superseded this one
        var svgHost = document.createElement('div')
        svgHost.className = 'wb-mermaid-svg'
        svgHost.innerHTML = out.svg
        wrap.innerHTML = ''
        wrap.appendChild(svgHost)
        installPanZoom(wrap, svgHost)
        buildToolbar(toolbar, svgHost, source)
      })
      .catch(function (err) {
        if (seq !== renderSeq) return
        showError(wrap, (err && err.message) || String(err), source)
        // Clean up any stray mermaid error node it appended to <body>.
        var stray = document.getElementById('d' + id) || document.getElementById(id)
        if (stray && stray.parentElement === document.body) stray.remove()
      })
  }

  function showError(wrap, message, source) {
    wrap.innerHTML = ''
    var card = document.createElement('div')
    card.className = 'wb-mermaid-error'
    var h = document.createElement('div')
    h.className = 'wb-mermaid-error-head'
    h.textContent = 'Mermaid syntax error'
    var m = document.createElement('div')
    m.className = 'wb-mermaid-error-msg'
    m.textContent = message
    var pre = document.createElement('pre')
    pre.className = 'wb-mermaid-error-src'
    pre.textContent = source
    card.appendChild(h)
    card.appendChild(m)
    card.appendChild(pre)
    wrap.appendChild(card)
  }

  function buildToolbar(toolbar, svgHost, source) {
    toolbar.innerHTML = ''
    var copy = mkBtn('copy source', function () {
      try {
        navigator.clipboard.writeText(source)
        copy.textContent = 'copied ✓'
        setTimeout(function () {
          copy.textContent = 'copy source'
        }, 1500)
      } catch (e) {}
    })
    var dl = mkBtn('download .svg', function () {
      var svg = svgHost.querySelector('svg')
      if (!svg) return
      var blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' })
      var url = URL.createObjectURL(blob)
      var a = document.createElement('a')
      a.href = url
      a.download = 'diagram.svg'
      a.click()
      setTimeout(function () {
        URL.revokeObjectURL(url)
      }, 1000)
    })
    var reset = mkBtn('reset view', function () {
      svgHost.dispatchEvent(new CustomEvent('wb-reset'))
    })
    toolbar.appendChild(copy)
    toolbar.appendChild(dl)
    toolbar.appendChild(reset)
  }

  function mkBtn(label, fn) {
    var b = document.createElement('button')
    b.className = 'wb-mini-btn'
    b.textContent = label
    b.addEventListener('click', fn)
    return b
  }

  // wheel zoom + drag pan by transforming the svg host.
  function installPanZoom(viewport, svgHost) {
    var scale = 1
    var tx = 0
    var ty = 0
    var dragging = false
    var sx = 0
    var sy = 0
    function apply() {
      svgHost.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'
    }
    svgHost.style.transformOrigin = '0 0'
    viewport.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault()
        var factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
        var newScale = Math.min(8, Math.max(0.2, scale * factor))
        // zoom toward pointer
        var rect = viewport.getBoundingClientRect()
        var px = e.clientX - rect.left
        var py = e.clientY - rect.top
        tx = px - (px - tx) * (newScale / scale)
        ty = py - (py - ty) * (newScale / scale)
        scale = newScale
        apply()
      },
      { passive: false }
    )
    viewport.addEventListener('mousedown', function (e) {
      dragging = true
      sx = e.clientX - tx
      sy = e.clientY - ty
      viewport.classList.add('dragging')
    })
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return
      tx = e.clientX - sx
      ty = e.clientY - sy
      apply()
    })
    window.addEventListener('mouseup', function () {
      dragging = false
      viewport.classList.remove('dragging')
    })
    svgHost.addEventListener('wb-reset', function () {
      scale = 1
      tx = 0
      ty = 0
      apply()
    })
    apply()
  }

  root.WBMermaid = { renderMermaid: renderMermaid }
})(window)
