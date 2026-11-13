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
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
} as const

export type IconName = keyof typeof PATHS

export function icon(name: IconName, cls = "size-4"): SVGSVGElement {
  const tpl = document.createElement("template")
  const fill = name === "grip" ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor"'
  tpl.innerHTML = `<svg viewBox="0 0 24 24" ${fill} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${cls}">${PATHS[name]}</svg>`
  return tpl.content.firstElementChild as SVGSVGElement
}
