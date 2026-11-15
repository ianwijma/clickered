/** Inline SVG icons (24x24 viewBox, stroke = currentColor). */
const PATHS = {
  target:
    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  crown: '<path d="M3.5 8.5 8 12l4-6.5 4 6.5 4.5-3.5-1.8 9.5H5.3z"/>',
  alert:
    '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.25" r=".6" fill="currentColor"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
} as const

export type IconName = keyof typeof PATHS

export function icon(name: IconName, cls = "size-4"): SVGSVGElement {
  const tpl = document.createElement("template")
  const fill = name === "grip" ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor"'
  tpl.innerHTML = `<svg viewBox="0 0 24 24" ${fill} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${cls}">${PATHS[name]}</svg>`
  return tpl.content.firstElementChild as SVGSVGElement
}

let appIconCount = 0

/**
 * The app icon (orange rounded square, three cursors) as inline SVG. The cursors pop in one
 * after another on a loop (`logo-pop` in styles.css). Ids are unique per instance.
 */
export function appIcon(cls = "size-10"): SVGSVGElement {
  const n = ++appIconCount
  const bg = `app-icon-bg-${n}`
  const cur = `app-icon-cursor-${n}`
  const tpl = document.createElement("template")
  tpl.innerHTML =
    `<svg viewBox="0 0 512 512" aria-hidden="true" class="${cls}"><defs>` +
    `<linearGradient id="${bg}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fb923c"/><stop offset="1" stop-color="#ea580c"/></linearGradient>` +
    `<path id="${cur}" d="M0 0V170L42 132L70 196L101 182L73 120H130Z" stroke="#9a3412" stroke-width="16" stroke-linejoin="round"/></defs>` +
    `<rect width="512" height="512" rx="112" fill="url(#${bg})"/><g transform="translate(106 100)">` +
    `<g class="logo-c"><use href="#${cur}" transform="scale(.82)" fill="#fed7aa"/></g>` +
    `<g class="logo-c logo-c2"><use href="#${cur}" transform="translate(105 72) scale(.82)" fill="#ffedd5"/></g>` +
    `<g class="logo-c logo-c3"><use href="#${cur}" transform="translate(210 144) scale(.82)" fill="#fff"/></g>` +
    `</g></svg>`
  return tpl.content.firstElementChild as SVGSVGElement
}
