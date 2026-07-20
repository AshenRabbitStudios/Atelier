/* ───────────────────────────────────────────────────────────────────────────
   Whiteboard — tiny hand-rolled markdown renderer for note boards.
   Supports: # h1..### h3, - / * bullet lists, 1. ordered lists, **bold**, *italic*,
   `inline code`, ```code fences```, --- rules, paragraphs, [text](url) links (rendered
   as plain <a> with no navigation — the sandbox has no network anyway).
   Escapes HTML first, so it never injects markup from the source. Never throws.
   ─────────────────────────────────────────────────────────────────────────── */
;(function (root) {
  'use strict'

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  // Inline spans on an already-HTML-escaped string.
  function inline(s) {
    // code first (protect its contents from other rules)
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

  function render(md) {
    var lines = String(md == null ? '' : md).split(/\r?\n/)
    var html = []
    var i = 0
    var listType = null // 'ul' | 'ol' | null

    function closeList() {
      if (listType) {
        html.push('</' + listType + '>')
        listType = null
      }
    }

    while (i < lines.length) {
      var raw = lines[i]
      // fenced code block
      if (/^```/.test(raw.trim())) {
        closeList()
        var buf = []
        i++
        while (i < lines.length && !/^```/.test(lines[i].trim())) {
          buf.push(esc(lines[i]))
          i++
        }
        i++ // skip closing fence
        html.push('<pre><code>' + buf.join('\n') + '</code></pre>')
        continue
      }
      var line = raw.trim()
      if (line === '') {
        closeList()
        i++
        continue
      }
      // horizontal rule
      if (/^---+$/.test(line)) {
        closeList()
        html.push('<hr />')
        i++
        continue
      }
      // headings
      var h = /^(#{1,3})\s+(.*)$/.exec(line)
      if (h) {
        closeList()
        var lvl = h[1].length
        html.push('<h' + lvl + '>' + inline(esc(h[2])) + '</h' + lvl + '>')
        i++
        continue
      }
      // ordered list
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
      // unordered list
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
      // paragraph (accumulate consecutive non-blank, non-special lines)
      closeList()
      var para = [esc(line)]
      i++
      while (i < lines.length) {
        var nxt = lines[i].trim()
        if (
          nxt === '' ||
          /^(#{1,3})\s/.test(nxt) ||
          /^[-*]\s/.test(nxt) ||
          /^\d+\.\s/.test(nxt) ||
          /^```/.test(nxt) ||
          /^---+$/.test(nxt)
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

  root.WBNote = { render: render }
})(window)
