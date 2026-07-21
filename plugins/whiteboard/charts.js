/* ───────────────────────────────────────────────────────────────────────────
   Whiteboard — hand-rolled SVG chart renderer (no chart library).
   Supports: bar (grouped), line, area (multi-series), scatter, pie.
   Themed with the host CSS variables; a fixed fallback palette for series.
   renderChart(container, board) draws into `container` (clears it first).
   Never throws on malformed board data — it renders what it can + a note.
   ─────────────────────────────────────────────────────────────────────────── */
;(function (root) {
  'use strict'
  var SVGNS = 'http://www.w3.org/2000/svg'
  // Fixed fallback palette (theme accent used for the first series where possible).
  var PALETTE = [
    '#5b9cff',
    '#f0883e',
    '#3fb950',
    '#db61a2',
    '#a371f7',
    '#e3b341',
    '#39c5cf',
    '#f85149'
  ]

  function el(name, attrs, parent) {
    var e = document.createElementNS(SVGNS, name)
    if (attrs) {
      for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k])
    }
    if (parent) parent.appendChild(e)
    return e
  }

  function num(v) {
    var n = Number(v)
    return isFinite(n) ? n : 0
  }

  function seriesColor(i) {
    return PALETTE[i % PALETTE.length]
  }

  // Nice tick step for an axis given a value range.
  function niceTicks(min, max, count) {
    if (min === max) {
      min -= 1
      max += 1
    }
    var span = max - min
    var step = Math.pow(10, Math.floor(Math.log10(span / count)))
    var err = span / count / step
    if (err >= 7.5) step *= 10
    else if (err >= 3) step *= 5
    else if (err >= 1.5) step *= 2
    var t0 = Math.floor(min / step) * step
    var t1 = Math.ceil(max / step) * step
    var ticks = []
    for (var v = t0; v <= t1 + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
    return ticks
  }

  function fmt(n) {
    if (!isFinite(n)) return ''
    if (Number.isInteger(n)) return String(n)
    return String(Math.round(n * 1000) / 1000)
  }

  /* Public entry — draws the chart of `board` into `container`. */
  function renderChart(container, board) {
    container.innerHTML = ''
    var kind = (board && board.chart) || 'bar'
    var W = Math.max(container.clientWidth || 520, 320)
    var H = Math.max(container.clientHeight || 360, 240)
    // Reserve a bottom strip for the legend.
    var svg = el(
      'svg',
      { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'wb-chart' },
      container
    )
    svg.style.display = 'block'

    var tip = document.createElement('div')
    tip.className = 'wb-chart-tip'
    tip.style.display = 'none'
    container.appendChild(tip)

    try {
      if (kind === 'pie') renderPie(svg, board, W, H, tip)
      else if (kind === 'scatter') renderScatter(svg, board, W, H, tip)
      else if (kind === 'waterfall') renderWaterfall(svg, board, W, H, tip)
      else renderXY(svg, board, W, H, kind, tip)
    } catch (e) {
      var note = el('text', { x: 12, y: 20, fill: 'var(--danger,#f85149)', 'font-size': 12 }, svg)
      note.textContent = 'chart error: ' + ((e && e.message) || e)
    }
  }

  // Shared axis frame for bar/line/area (categorical x).
  function renderXY(svg, board, W, H, kind, tip) {
    var margin = { t: 16, r: 16, b: 56, l: 48 }
    var plotW = W - margin.l - margin.r
    var plotH = H - margin.t - margin.b
    var cats = (board.x && board.x.categories) || []
    var series = Array.isArray(board.series) ? board.series : []

    // y-range across all series
    var vmin = 0
    var vmax = 0
    var any = false
    series.forEach(function (s) {
      ;(s.values || []).forEach(function (v) {
        var n = num(v)
        if (!any) {
          vmin = vmax = n
          any = true
        }
        if (n < vmin) vmin = n
        if (n > vmax) vmax = n
      })
    })
    if (!any) {
      vmin = 0
      vmax = 1
    }
    if (vmin > 0) vmin = 0 // baseline at zero for bars/area
    var ticks = niceTicks(vmin, vmax, 5)
    var yLo = ticks[0]
    var yHi = ticks[ticks.length - 1]
    function yPix(v) {
      return margin.t + plotH - ((num(v) - yLo) / (yHi - yLo || 1)) * plotH
    }
    var n = cats.length
    var bandW = plotW / Math.max(n, 1)
    function xCenter(i) {
      return margin.l + bandW * (i + 0.5)
    }

    // grid + y ticks
    ticks.forEach(function (t) {
      var y = yPix(t)
      el(
        'line',
        {
          x1: margin.l,
          y1: y,
          x2: margin.l + plotW,
          y2: y,
          stroke: 'var(--border,#252b37)',
          'stroke-width': 1
        },
        svg
      )
      var lab = el(
        'text',
        {
          x: margin.l - 6,
          y: y + 3,
          fill: 'var(--faint,#5e6677)',
          'font-size': 10,
          'text-anchor': 'end'
        },
        svg
      )
      lab.textContent = fmt(t)
    })
    // axis lines
    el(
      'line',
      {
        x1: margin.l,
        y1: margin.t,
        x2: margin.l,
        y2: margin.t + plotH,
        stroke: 'var(--border-2,#333b4b)'
      },
      svg
    )
    el(
      'line',
      {
        x1: margin.l,
        y1: margin.t + plotH,
        x2: margin.l + plotW,
        y2: margin.t + plotH,
        stroke: 'var(--border-2,#333b4b)'
      },
      svg
    )

    // x category labels
    cats.forEach(function (c, i) {
      var lab = el(
        'text',
        {
          x: xCenter(i),
          y: margin.t + plotH + 16,
          fill: 'var(--dim,#8892a4)',
          'font-size': 10,
          'text-anchor': 'middle'
        },
        svg
      )
      lab.textContent = String(c)
    })
    // axis titles
    if (board.x && board.x.label) {
      var xt = el(
        'text',
        {
          x: margin.l + plotW / 2,
          y: H - 22,
          fill: 'var(--faint,#5e6677)',
          'font-size': 11,
          'text-anchor': 'middle'
        },
        svg
      )
      xt.textContent = board.x.label
    }
    if (board.y && board.y.label) {
      var yt = el(
        'text',
        {
          x: 12,
          y: margin.t + plotH / 2,
          fill: 'var(--faint,#5e6677)',
          'font-size': 11,
          'text-anchor': 'middle',
          transform: 'rotate(-90 12 ' + (margin.t + plotH / 2) + ')'
        },
        svg
      )
      yt.textContent = board.y.label
    }

    if (kind === 'bar') {
      var m = series.length || 1
      var groupPad = bandW * 0.18
      var barW = (bandW - groupPad * 2) / m
      series.forEach(function (s, si) {
        ;(s.values || []).forEach(function (v, i) {
          var x = margin.l + bandW * i + groupPad + si * barW
          var y0 = yPix(0)
          var y1 = yPix(v)
          var top = Math.min(y0, y1)
          var h = Math.abs(y1 - y0)
          var rect = el(
            'rect',
            {
              x: x + 1,
              y: top,
              width: Math.max(barW - 2, 1),
              height: h,
              fill: seriesColor(si),
              rx: 1
            },
            svg
          )
          bindTip(rect, tip, (cats[i] != null ? cats[i] + ' · ' : '') + s.name + ': ' + fmt(num(v)))
        })
      })
    } else {
      // line / area
      series.forEach(function (s, si) {
        var pts = (s.values || []).map(function (v, i) {
          return [xCenter(i), yPix(v)]
        })
        if (!pts.length) return
        var dLine = pts
          .map(function (p, i) {
            return (i === 0 ? 'M' : 'L') + p[0] + ' ' + p[1]
          })
          .join(' ')
        if (kind === 'area') {
          var base = yPix(Math.max(yLo, 0))
          var dArea =
            dLine +
            ' L ' +
            pts[pts.length - 1][0] +
            ' ' +
            base +
            ' L ' +
            pts[0][0] +
            ' ' +
            base +
            ' Z'
          el('path', { d: dArea, fill: seriesColor(si), 'fill-opacity': 0.18, stroke: 'none' }, svg)
        }
        el('path', { d: dLine, fill: 'none', stroke: seriesColor(si), 'stroke-width': 2 }, svg)
        pts.forEach(function (p, i) {
          var c = el('circle', { cx: p[0], cy: p[1], r: 3, fill: seriesColor(si) }, svg)
          bindTip(
            c,
            tip,
            (cats[i] != null ? cats[i] + ' · ' : '') + s.name + ': ' + fmt(num((s.values || [])[i]))
          )
        })
      })
    }
    drawLegend(
      svg,
      series.map(function (s) {
        return s.name
      }),
      W,
      H
    )
  }

  // Waterfall: the FIRST series' values are deltas; each bar floats from the running total
  // before it to the running total after it. Positive deltas green-ish, negative red-ish,
  // and a final computed "total" bar in the neutral accent. Categories from x.categories.
  function renderWaterfall(svg, board, W, H, tip) {
    var margin = { t: 16, r: 16, b: 56, l: 48 }
    var plotW = W - margin.l - margin.r
    var plotH = H - margin.t - margin.b
    var series = Array.isArray(board.series) ? board.series : []
    var deltas = ((series[0] && series[0].values) || []).map(num)
    var cats = ((board.x && board.x.categories) || []).slice(0, deltas.length)
    while (cats.length < deltas.length) cats.push('step ' + (cats.length + 1))
    // running totals: level[i] = sum of deltas[0..i-1]
    var levels = [0]
    for (var i = 0; i < deltas.length; i++) levels.push(levels[i] + deltas[i])
    var total = levels[levels.length - 1]
    var vmin = Math.min.apply(null, levels.concat([0]))
    var vmax = Math.max.apply(null, levels.concat([0]))
    var ticks = niceTicks(vmin, vmax, 5)
    var yLo = ticks[0]
    var yHi = ticks[ticks.length - 1]
    function yPix(v) {
      return margin.t + plotH - ((num(v) - yLo) / (yHi - yLo || 1)) * plotH
    }
    var n = deltas.length + 1 // + the total bar
    var bandW = plotW / Math.max(n, 1)

    ticks.forEach(function (t) {
      var y = yPix(t)
      el(
        'line',
        { x1: margin.l, y1: y, x2: margin.l + plotW, y2: y, stroke: 'var(--border,#252b37)' },
        svg
      )
      var lab = el(
        'text',
        {
          x: margin.l - 6,
          y: y + 3,
          fill: 'var(--faint,#5e6677)',
          'font-size': 10,
          'text-anchor': 'end'
        },
        svg
      )
      lab.textContent = fmt(t)
    })
    el(
      'line',
      {
        x1: margin.l,
        y1: margin.t,
        x2: margin.l,
        y2: margin.t + plotH,
        stroke: 'var(--border-2,#333b4b)'
      },
      svg
    )
    el(
      'line',
      {
        x1: margin.l,
        y1: margin.t + plotH,
        x2: margin.l + plotW,
        y2: margin.t + plotH,
        stroke: 'var(--border-2,#333b4b)'
      },
      svg
    )

    var POS = '#3fb950'
    var NEG = '#f85149'
    var TOT = 'var(--accent,#5b9cff)'
    var pad = bandW * 0.18

    function bar(idx, from, to, color, label) {
      var x = margin.l + bandW * idx + pad
      var y0 = yPix(from)
      var y1 = yPix(to)
      var top = Math.min(y0, y1)
      var h = Math.max(Math.abs(y1 - y0), 1)
      var rect = el(
        'rect',
        { x: x, y: top, width: Math.max(bandW - pad * 2, 2), height: h, fill: color, rx: 1 },
        svg
      )
      bindTip(rect, tip, label)
      // connector to the next band
      if (idx < n - 1) {
        el(
          'line',
          {
            x1: x + Math.max(bandW - pad * 2, 2),
            y1: yPix(to),
            x2: margin.l + bandW * (idx + 1) + pad,
            y2: yPix(to),
            stroke: 'var(--faint,#5e6677)',
            'stroke-dasharray': '3 2'
          },
          svg
        )
      }
    }

    deltas.forEach(function (d, di) {
      bar(
        di,
        levels[di],
        levels[di + 1],
        d >= 0 ? POS : NEG,
        cats[di] + ': ' + (d >= 0 ? '+' : '') + fmt(d) + ' → ' + fmt(levels[di + 1])
      )
    })
    bar(n - 1, 0, total, TOT, 'total: ' + fmt(total))

    cats.concat(['total']).forEach(function (c, ci) {
      var lab = el(
        'text',
        {
          x: margin.l + bandW * (ci + 0.5),
          y: margin.t + plotH + 16,
          fill: 'var(--dim,#8892a4)',
          'font-size': 10,
          'text-anchor': 'middle'
        },
        svg
      )
      lab.textContent = String(c)
    })
    if (board.y && board.y.label) {
      var yl = el(
        'text',
        {
          x: 12,
          y: margin.t + plotH / 2,
          fill: 'var(--faint,#5e6677)',
          'font-size': 11,
          'text-anchor': 'middle',
          transform: 'rotate(-90 12 ' + (margin.t + plotH / 2) + ')'
        },
        svg
      )
      yl.textContent = board.y.label
    }
  }

  function renderScatter(svg, board, W, H, tip) {
    var margin = { t: 16, r: 16, b: 56, l: 48 }
    var plotW = W - margin.l - margin.r
    var plotH = H - margin.t - margin.b
    var series = Array.isArray(board.series) ? board.series : []
    var xs = [],
      ys = []
    series.forEach(function (s) {
      ;(s.points || []).forEach(function (p) {
        xs.push(num(p[0]))
        ys.push(num(p[1]))
      })
    })
    if (!xs.length) {
      xs = [0, 1]
      ys = [0, 1]
    }
    var xt = niceTicks(Math.min.apply(null, xs), Math.max.apply(null, xs), 5)
    var yt = niceTicks(Math.min.apply(null, ys), Math.max.apply(null, ys), 5)
    var xLo = xt[0],
      xHi = xt[xt.length - 1],
      yLo = yt[0],
      yHi = yt[yt.length - 1]
    function xPix(v) {
      return margin.l + ((num(v) - xLo) / (xHi - xLo || 1)) * plotW
    }
    function yPix(v) {
      return margin.t + plotH - ((num(v) - yLo) / (yHi - yLo || 1)) * plotH
    }

    yt.forEach(function (t) {
      var y = yPix(t)
      el(
        'line',
        { x1: margin.l, y1: y, x2: margin.l + plotW, y2: y, stroke: 'var(--border,#252b37)' },
        svg
      )
      var l = el(
        'text',
        {
          x: margin.l - 6,
          y: y + 3,
          fill: 'var(--faint,#5e6677)',
          'font-size': 10,
          'text-anchor': 'end'
        },
        svg
      )
      l.textContent = fmt(t)
    })
    xt.forEach(function (t) {
      var x = xPix(t)
      var l = el(
        'text',
        {
          x: x,
          y: margin.t + plotH + 16,
          fill: 'var(--faint,#5e6677)',
          'font-size': 10,
          'text-anchor': 'middle'
        },
        svg
      )
      l.textContent = fmt(t)
    })
    el(
      'line',
      {
        x1: margin.l,
        y1: margin.t,
        x2: margin.l,
        y2: margin.t + plotH,
        stroke: 'var(--border-2,#333b4b)'
      },
      svg
    )
    el(
      'line',
      {
        x1: margin.l,
        y1: margin.t + plotH,
        x2: margin.l + plotW,
        y2: margin.t + plotH,
        stroke: 'var(--border-2,#333b4b)'
      },
      svg
    )
    if (board.x && board.x.label) {
      var xl = el(
        'text',
        {
          x: margin.l + plotW / 2,
          y: H - 22,
          fill: 'var(--faint,#5e6677)',
          'font-size': 11,
          'text-anchor': 'middle'
        },
        svg
      )
      xl.textContent = board.x.label
    }
    if (board.y && board.y.label) {
      var yl = el(
        'text',
        {
          x: 12,
          y: margin.t + plotH / 2,
          fill: 'var(--faint,#5e6677)',
          'font-size': 11,
          'text-anchor': 'middle',
          transform: 'rotate(-90 12 ' + (margin.t + plotH / 2) + ')'
        },
        svg
      )
      yl.textContent = board.y.label
    }
    series.forEach(function (s, si) {
      ;(s.points || []).forEach(function (p) {
        var c = el(
          'circle',
          { cx: xPix(p[0]), cy: yPix(p[1]), r: 4, fill: seriesColor(si), 'fill-opacity': 0.8 },
          svg
        )
        bindTip(c, tip, s.name + ': (' + fmt(num(p[0])) + ', ' + fmt(num(p[1])) + ')')
      })
    })
    drawLegend(
      svg,
      series.map(function (s) {
        return s.name
      }),
      W,
      H
    )
  }

  function renderPie(svg, board, W, H, tip) {
    // Pie takes the first series' values against x.categories as labels.
    var series = Array.isArray(board.series) ? board.series : []
    var vals = (series[0] && series[0].values) || []
    var labels =
      (board.x && board.x.categories) ||
      vals.map(function (_, i) {
        return 'slice ' + (i + 1)
      })
    var total = vals.reduce(function (a, v) {
      return a + Math.abs(num(v))
    }, 0)
    var cx = W / 2,
      cy = (H - 40) / 2 + 8,
      r = Math.min(W, H - 40) / 2 - 16
    if (total <= 0) {
      var t = el(
        'text',
        { x: cx, y: cy, fill: 'var(--faint,#5e6677)', 'font-size': 12, 'text-anchor': 'middle' },
        svg
      )
      t.textContent = 'no data'
      return
    }
    var a0 = -Math.PI / 2
    vals.forEach(function (v, i) {
      var frac = Math.abs(num(v)) / total
      var a1 = a0 + frac * Math.PI * 2
      var large = a1 - a0 > Math.PI ? 1 : 0
      var x0 = cx + r * Math.cos(a0),
        y0 = cy + r * Math.sin(a0)
      var x1 = cx + r * Math.cos(a1),
        y1 = cy + r * Math.sin(a1)
      var d =
        'M ' +
        cx +
        ' ' +
        cy +
        ' L ' +
        x0 +
        ' ' +
        y0 +
        ' A ' +
        r +
        ' ' +
        r +
        ' 0 ' +
        large +
        ' 1 ' +
        x1 +
        ' ' +
        y1 +
        ' Z'
      var seg = el(
        'path',
        { d: d, fill: seriesColor(i), stroke: 'var(--surface,#14171e)', 'stroke-width': 1 },
        svg
      )
      bindTip(seg, tip, labels[i] + ': ' + fmt(num(v)) + ' (' + Math.round(frac * 100) + '%)')
      a0 = a1
    })
    drawLegend(svg, labels, W, H)
  }

  function drawLegend(svg, names, W, H) {
    var y = H - 8
    var x = 12
    names.forEach(function (nm, i) {
      var g = el('g', {}, svg)
      el('rect', { x: x, y: y - 9, width: 10, height: 10, fill: seriesColor(i), rx: 2 }, g)
      var t = el('text', { x: x + 15, y: y, fill: 'var(--dim,#8892a4)', 'font-size': 11 }, g)
      t.textContent = nm == null ? 'series ' + (i + 1) : String(nm)
      // advance x by an estimate (11px char font ≈ 6.2px/char)
      x += 15 + 6 + String(nm || '').length * 6.2 + 16
    })
  }

  function bindTip(node, tip, text) {
    node.style.cursor = 'default'
    node.addEventListener('mouseenter', function (ev) {
      tip.textContent = text
      tip.style.display = 'block'
      moveTip(tip, ev)
    })
    node.addEventListener('mousemove', function (ev) {
      moveTip(tip, ev)
    })
    node.addEventListener('mouseleave', function () {
      tip.style.display = 'none'
    })
  }

  function moveTip(tip, ev) {
    var host = tip.parentElement
    var rect = host.getBoundingClientRect()
    tip.style.left = ev.clientX - rect.left + 12 + 'px'
    tip.style.top = ev.clientY - rect.top + 12 + 'px'
  }

  root.WBCharts = { renderChart: renderChart }
})(window)
