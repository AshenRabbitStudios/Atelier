// Workspace Explorer — small markdown renderer for the preview pane's "rendered" mode.
// Same hand-rolled subset as the whiteboard note renderer (h1-h3, lists, fences, bold/
// italic/code/links, rules) plus pipe tables, which repo docs use heavily. Escapes HTML
// first; never throws. Loaded as a plain <script> (sets window.WXMd).
;(function () {
  'use strict'

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function inline(s) {
    s = s.replace(/`([^`]+)`/g, function (_, c) {
      return '<code>' + c + '</code>'
    })
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, txt, href) {
      return '<a href="' + esc(href) + '" rel="noopener">' + txt + '</a>'
    })
    return s
  }

  function isTableRow(line) {
    return /^\|.*\|\s*$/.test(line)
  }
  function isTableSep(line) {
    return /^\|[\s:|-]+\|\s*$/.test(line) && line.indexOf('-') >= 0
  }
  function splitRow(line) {
    return line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map(function (c) {
        return c.trim()
      })
  }

  function render(md) {
    var lines = String(md == null ? '' : md).split(/\r?\n/)
    var html = []
    var i = 0
    var listType = null

    function closeList() {
      if (listType) {
        html.push('</' + listType + '>')
        listType = null
      }
    }

    while (i < lines.length) {
      var raw = lines[i]
      if (/^```/.test(raw.trim())) {
        closeList()
        var buf = []
        i++
        while (i < lines.length && !/^```/.test(lines[i].trim())) {
          buf.push(esc(lines[i]))
          i++
        }
        i++
        html.push('<pre><code>' + buf.join('\n') + '</code></pre>')
        continue
      }
      var line = raw.trim()
      if (line === '') {
        closeList()
        i++
        continue
      }
      // pipe table: header row + separator row, then body rows
      if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
        closeList()
        var head = splitRow(line)
        i += 2
        var body = []
        while (i < lines.length && isTableRow(lines[i].trim())) {
          body.push(splitRow(lines[i].trim()))
          i++
        }
        var t = ['<table><thead><tr>']
        head.forEach(function (h) {
          t.push('<th>' + inline(esc(h)) + '</th>')
        })
        t.push('</tr></thead><tbody>')
        body.forEach(function (r) {
          t.push('<tr>')
          r.forEach(function (c) {
            t.push('<td>' + inline(esc(c)) + '</td>')
          })
          t.push('</tr>')
        })
        t.push('</tbody></table>')
        html.push(t.join(''))
        continue
      }
      if (/^---+$/.test(line)) {
        closeList()
        html.push('<hr />')
        i++
        continue
      }
      var h = /^(#{1,4})\s+(.*)$/.exec(line)
      if (h) {
        closeList()
        var lvl = Math.min(h[1].length, 4)
        html.push('<h' + lvl + '>' + inline(esc(h[2])) + '</h' + lvl + '>')
        i++
        continue
      }
      var ol = /^\d+\.\s+(.*)$/.exec(line)
      if (ol) {
        if (listType !== 'ol') {
          closeList()
          html.push('<ol>')
          listType = 'ol'
        }
        html.push('<li>' + inline(esc(ol[1])) + '</li>')
        i++
        continue
      }
      var ul = /^[-*]\s+(.*)$/.exec(line)
      if (ul) {
        if (listType !== 'ul') {
          closeList()
          html.push('<ul>')
          listType = 'ul'
        }
        html.push('<li>' + inline(esc(ul[1])) + '</li>')
        i++
        continue
      }
      closeList()
      var para = [esc(line)]
      i++
      while (i < lines.length) {
        var nxt = lines[i].trim()
        if (
          nxt === '' ||
          /^(#{1,4})\s/.test(nxt) ||
          /^[-*]\s/.test(nxt) ||
          /^\d+\.\s/.test(nxt) ||
          /^```/.test(nxt) ||
          /^---+$/.test(nxt) ||
          isTableRow(nxt)
        )
          break
        para.push(esc(nxt))
        i++
      }
      html.push('<p>' + inline(para.join(' ')) + '</p>')
    }
    closeList()
    return html.join('\n')
  }

  window.WXMd = { render: render }
})()
