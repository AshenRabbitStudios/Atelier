// Workspace Explorer — file-type icon registry. Inline SVG, no assets, themed by hue so a
// glance tells the type: colored document glyphs with a short type label for code, distinct
// shapes for folders / images / locks / git / packages. iconFor() returns an SVG string.
//
// Loaded as a plain <script> before explorer.js (sets window.WXIcons).
;(function () {
  'use strict'

  // Type-family colors (approximate the conventions people already know).
  var C = {
    js: '#e3b341',
    ts: '#5b9cff',
    py: '#3fb950',
    rs: '#f0883e',
    go: '#39c5cf',
    web: '#f0883e',
    style: '#a371f7',
    data: '#e3b341',
    doc: '#6b9fff',
    img: '#db61a2',
    shell: '#3fb950',
    git: '#f0883e',
    pkg: '#f85149',
    lock: '#8892a4',
    conf: '#8892a4',
    c: '#5b9cff',
    java: '#f0883e',
    plain: '#8892a4'
  }

  // ext -> { color, label } (label is drawn inside the doc glyph; <=4 chars reads fine)
  var EXT = {
    js: { color: C.js, label: 'JS' },
    mjs: { color: C.js, label: 'JS' },
    cjs: { color: C.js, label: 'JS' },
    jsx: { color: C.js, label: 'JSX' },
    ts: { color: C.ts, label: 'TS' },
    tsx: { color: C.ts, label: 'TSX' },
    py: { color: C.py, label: 'PY' },
    rs: { color: C.rs, label: 'RS' },
    go: { color: C.go, label: 'GO' },
    java: { color: C.java, label: 'JAVA' },
    c: { color: C.c, label: 'C' },
    h: { color: C.c, label: 'H' },
    cpp: { color: C.c, label: 'C++' },
    cc: { color: C.c, label: 'C++' },
    hpp: { color: C.c, label: 'H++' },
    cs: { color: C.style, label: 'C#' },
    rb: { color: C.pkg, label: 'RB' },
    php: { color: C.style, label: 'PHP' },
    swift: { color: C.rs, label: 'SW' },
    kt: { color: C.rs, label: 'KT' },
    lua: { color: C.ts, label: 'LUA' },
    html: { color: C.web, label: '<>' },
    htm: { color: C.web, label: '<>' },
    vue: { color: C.py, label: 'VUE' },
    svelte: { color: C.rs, label: 'SVL' },
    css: { color: C.style, label: '#' },
    scss: { color: C.style, label: '#' },
    less: { color: C.style, label: '#' },
    json: { color: C.data, label: '{}' },
    jsonc: { color: C.data, label: '{}' },
    yaml: { color: C.data, label: 'YML' },
    yml: { color: C.data, label: 'YML' },
    toml: { color: C.data, label: 'TML' },
    xml: { color: C.data, label: 'XML' },
    csv: { color: C.py, label: 'CSV' },
    tsv: { color: C.py, label: 'TSV' },
    sql: { color: C.ts, label: 'SQL' },
    md: { color: C.doc, label: 'M↓' },
    markdown: { color: C.doc, label: 'M↓' },
    txt: { color: C.plain, label: 'TXT' },
    pdf: { color: C.pkg, label: 'PDF' },
    rst: { color: C.doc, label: 'RST' },
    sh: { color: C.shell, label: '$_' },
    bash: { color: C.shell, label: '$_' },
    zsh: { color: C.shell, label: '$_' },
    ps1: { color: C.ts, label: 'PS' },
    bat: { color: C.shell, label: 'BAT' },
    cmd: { color: C.shell, label: 'BAT' },
    zip: { color: C.conf, label: 'ZIP' },
    gz: { color: C.conf, label: 'GZ' },
    tar: { color: C.conf, label: 'TAR' },
    '7z': { color: C.conf, label: '7Z' },
    woff: { color: C.style, label: 'FNT' },
    woff2: { color: C.style, label: 'FNT' },
    ttf: { color: C.style, label: 'FNT' },
    exe: { color: C.pkg, label: 'EXE' },
    dll: { color: C.conf, label: 'DLL' },
    wasm: { color: C.style, label: 'WSM' },
    env: { color: C.js, label: 'ENV' },
    log: { color: C.plain, label: 'LOG' }
  }

  var IMG_EXT = /^(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/

  // Exact-filename specials override the extension.
  var SPECIAL = {
    'package.json': { kind: 'pkg' },
    'package-lock.json': { kind: 'lock' },
    'yarn.lock': { kind: 'lock' },
    'pnpm-lock.yaml': { kind: 'lock' },
    'cargo.lock': { kind: 'lock' },
    '.gitignore': { kind: 'git' },
    '.gitattributes': { kind: 'git' },
    '.gitmodules': { kind: 'git' },
    dockerfile: { kind: 'docker' },
    'docker-compose.yml': { kind: 'docker' },
    makefile: { kind: 'shellfile' },
    license: { kind: 'license' },
    'license.md': { kind: 'license' },
    'license.txt': { kind: 'license' },
    '.env': { kind: 'envfile' },
    '.prettierrc.json': { kind: 'conf' },
    '.prettierignore': { kind: 'conf' },
    '.editorconfig': { kind: 'conf' },
    'claude.md': { kind: 'claude' },
    'readme.md': { kind: 'readme' }
  }

  function svgWrap(inner) {
    return (
      '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1">' +
      inner +
      '</svg>'
    )
  }

  // Document outline with a folded corner; label text drawn under the fold.
  function docIcon(color, label) {
    var text = label
      ? '<text x="8" y="12.5" text-anchor="middle" font-size="' +
        (label.length > 2 ? 4.6 : 5.6) +
        '" font-family="ui-monospace,monospace" font-weight="700" fill="' +
        color +
        '" stroke="none">' +
        label +
        '</text>'
      : ''
    return (
      '<svg class="icon" viewBox="0 0 16 16" fill="none">' +
      '<path d="M3.5 1.8h6l3 3v9.4h-9z" stroke="' +
      color +
      '" stroke-opacity="0.75" stroke-width="1.1"/>' +
      '<path d="M9.5 1.8v3h3" stroke="' +
      color +
      '" stroke-opacity="0.75" stroke-width="1.1"/>' +
      text +
      '</svg>'
    )
  }

  function folderIcon(open, hasSpecial) {
    var color = hasSpecial || 'var(--wx-folder, #7a8aa8)'
    if (open) {
      return (
        '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="' +
        color +
        '" stroke-width="1.1">' +
        '<path d="M2 4.2h4l1.3 1.5h6.7" />' +
        '<path d="M2 4.2v8.6h11l1.6-6.1H4.6L3 12.8" fill="' +
        color +
        '" fill-opacity="0.14"/>' +
        '</svg>'
      )
    }
    return (
      '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="' +
      color +
      '" stroke-width="1.1">' +
      '<path d="M2 4.2h4l1.3 1.5h6.7v7.1H2z" fill="' +
      color +
      '" fill-opacity="0.2"/>' +
      '</svg>'
    )
  }

  function imageIcon() {
    return (
      '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="' +
      C.img +
      '" stroke-width="1.1">' +
      '<rect x="2" y="3" width="12" height="10" rx="1"/>' +
      '<circle cx="5.5" cy="6.5" r="1.2"/>' +
      '<path d="M2.5 11.5 6 8l3 3 2.5-2.5 2 2"/>' +
      '</svg>'
    )
  }

  var SPECIAL_SVG = {
    pkg: function () {
      return (
        '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="' +
        C.pkg +
        '" stroke-width="1.1">' +
        '<path d="M2.5 5 8 2l5.5 3v6L8 14l-5.5-3z" fill="' +
        C.pkg +
        '" fill-opacity="0.12"/>' +
        '<path d="M2.5 5 8 8l5.5-3M8 8v6"/>' +
        '</svg>'
      )
    },
    lock: function () {
      return (
        '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="' +
        C.lock +
        '" stroke-width="1.1">' +
        '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/>' +
        '<path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>' +
        '</svg>'
      )
    },
    git: function () {
      return (
        '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="' +
        C.git +
        '" stroke-width="1.1">' +
        '<circle cx="4.5" cy="3.5" r="1.4"/><circle cx="4.5" cy="12.5" r="1.4"/>' +
        '<circle cx="11.5" cy="6" r="1.4"/>' +
        '<path d="M4.5 5v6M11.5 7.4c0 2.6-2.5 2.4-5 3.4"/>' +
        '</svg>'
      )
    },
    docker: function () {
      return (
        '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="#39c5cf" stroke-width="1.1">' +
        '<path d="M1.5 8.5h13c-.5 3-2.5 5-6.5 5s-6-2-6.5-5z" fill="#39c5cf" fill-opacity="0.12"/>' +
        '<path d="M4 8.5V6h2v2.5M7 8.5V6h2v2.5M10 8.5V6h2v2.5M7 5V3h2v2"/>' +
        '</svg>'
      )
    },
    license: function () {
      return docIcon(C.doc, '§')
    },
    envfile: function () {
      return docIcon(C.js, 'ENV')
    },
    conf: function () {
      return (
        '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="' +
        C.conf +
        '" stroke-width="1.1">' +
        '<circle cx="8" cy="8" r="2.2"/>' +
        '<path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.2 4.2l1.4 1.4M10.4 10.4l1.4 1.4M11.8 4.2l-1.4 1.4M5.6 10.4 4.2 11.8"/>' +
        '</svg>'
      )
    },
    shellfile: function () {
      return docIcon(C.shell, '$_')
    },
    claude: function () {
      return docIcon('#d97757', 'AI')
    },
    readme: function () {
      return docIcon(C.py, 'i')
    }
  }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name)
    return m ? m[1].toLowerCase() : ''
  }

  /* Public: icon SVG string for an entry. kind: 'dir' | 'file'; open only for dirs. */
  function iconFor(name, kind, open) {
    if (kind === 'dir') return folderIcon(!!open)
    var lower = String(name || '').toLowerCase()
    var special = SPECIAL[lower]
    if (special && SPECIAL_SVG[special.kind]) return SPECIAL_SVG[special.kind]()
    var ext = extOf(lower)
    if (IMG_EXT.test(ext)) return imageIcon()
    var e = EXT[ext]
    if (e) return docIcon(e.color, e.label)
    // Unknown: neutral doc with a truncated uppercase ext (or no label).
    return docIcon(C.plain, ext ? ext.slice(0, 3).toUpperCase() : '')
  }

  window.WXIcons = { iconFor: iconFor, svgWrap: svgWrap }
})()
