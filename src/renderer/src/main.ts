import "./styles.css"
import {
  CLICK_DELAYS,
  CLICK_OFFSETS,
  type AppState,
  type ClickeredApi,
  type GroupWindow,
  type UpdateSnapshot,
} from "@shared/ipc"
import type { WindowId } from "@shared/protocol"
import {
  chipView,
  clickDelayLabel,
  clickOffsetLabel,
  countText,
  formatHotkey,
  groupName,
  permissionPhaseAfter,
  type PermissionPhase,
} from "./format"
import { appIcon, icon } from "./icons"

// ---------------------------------------------------------------------------
// Tiny DOM helpers. The DOM is built once; render() only patches it.

type Child = Node | string

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  node.append(...children)
  return node
}

function button(cls: string, label: string, ...children: Child[]): HTMLButtonElement {
  const b = el("button", cls, ...children)
  b.type = "button"
  if (label) {
    b.title = label
    b.setAttribute("aria-label", label)
  }
  return b
}

function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text
}
function setAttr(node: Element, name: string, value: string | null): void {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name)
  } else if (node.getAttribute(name) !== value) node.setAttribute(name, value)
}
function show(node: HTMLElement, visible: boolean): void {
  if (node.hidden === visible) node.hidden = !visible
}
function setFlag(node: Element, name: string, on: boolean): void {
  if (node.hasAttribute(name) !== on) node.toggleAttribute(name, on)
}

/** Small on/off switch (role="switch", styled via aria-checked). */
function smallSwitch(label: string): HTMLButtonElement {
  const knob = el(
    "span",
    "absolute top-0.5 left-0.5 size-3 rounded-full bg-white shadow-sm transition-transform duration-150 group-aria-checked:translate-x-3",
  )
  const sw = button(
    "group relative inline-block h-4 w-7 shrink-0 rounded-full bg-zinc-300 transition-colors duration-150 aria-checked:bg-emerald-600 dark:bg-zinc-600 dark:aria-checked:bg-emerald-500",
    label,
    knob,
  )
  sw.setAttribute("role", "switch")
  sw.setAttribute("aria-checked", "false")
  return sw
}

// ---------------------------------------------------------------------------

async function resolveApi(): Promise<ClickeredApi | null> {
  const api = (window as { clickered?: ClickeredApi }).clickered
  if (api) return api
  if (import.meta.env.DEV) {
    // Dev-only browser preview (never bundled into a production build).
    const mock = await import("./mock")
    return mock.installMock()
  }
  return null
}

const MUTED = "text-zinc-500 dark:text-zinc-400"
const ICON_BTN =
  "grid size-8 shrink-0 place-items-center rounded-full text-zinc-600 hover:bg-zinc-900/[.07] active:bg-zinc-900/[.12] dark:text-zinc-300 dark:hover:bg-white/10 dark:active:bg-white/15"

function start(api: ClickeredApi): void {
  let state: AppState | null = null
  let update: UpdateSnapshot = { status: "none", prereleases: false }
  let expanded = import.meta.env.DEV && new URLSearchParams(location.search).has("expanded")

  const app = document.getElementById("app") ?? document.body

  // ---- Bar ---------------------------------------------------------------

  const grip = el("span", "flex w-3.5 shrink-0 justify-center text-zinc-400 dark:text-zinc-500", icon("grip", "size-3.5"))
  grip.title = "Drag to move"

  // Mode: helper starting / error
  const statusIcon = el("span", "grid size-5 place-items-center", icon("alert", "size-4"))
  const statusText = el("span", "truncate")
  const segStatus = el("div", "flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-[13px]", statusIcon, statusText)

  // Mode: no group yet -> one call to action
  const ctaBtn = button(
    "flex h-8 flex-1 items-center justify-center gap-2 rounded-full bg-sky-600 px-4 text-[13px] font-semibold text-white hover:bg-sky-500 active:bg-sky-700 dark:bg-sky-500 dark:text-sky-950 dark:hover:bg-sky-400",
    "",
    icon("target", "size-4"),
    "Grab windows",
  )
  ctaBtn.title = "Then click each window you want to control, and press Done"
  const segEmpty = el("div", "flex min-w-0 flex-1", ctaBtn)

  // Mode: picking
  const pickCancel = button(
    "flex h-7 shrink-0 items-center gap-1 rounded-full bg-zinc-900/[.07] pl-2 pr-2.5 text-xs font-medium hover:bg-zinc-900/[.12] dark:bg-white/10 dark:hover:bg-white/15",
    "Finish picking (or right-click anywhere)",
    icon("check", "size-3.5"),
    "Done",
  )
  const pickTitle = el("span", "truncate text-[13px] font-semibold tabular-nums", "Click each window…")
  const segPick = el(
    "div",
    "flex min-w-0 flex-1 items-center gap-2 pl-1",
    el("span", "soft-pulse grid size-6 shrink-0 place-items-center text-sky-600 dark:text-sky-400", icon("target", "size-5")),
    el(
      "div",
      "flex min-w-0 flex-1 flex-col leading-tight",
      pickTitle,
      el("span", `truncate text-[11px] ${MUTED}`, "Click again to remove · right-click when done"),
    ),
    pickCancel,
  )

  // Mode: group
  const toggleKbd = el("kbd", "font-sans text-[11px] font-medium tabular-nums opacity-75")
  const toggle = button(
    "group flex h-8 shrink-0 items-center gap-2 rounded-full bg-zinc-200 pl-1.5 pr-3 text-[13px] font-semibold text-zinc-700 transition-colors duration-150 hover:bg-zinc-300 disabled:opacity-50 aria-checked:bg-emerald-600 aria-checked:text-white aria-checked:hover:bg-emerald-500 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-600 dark:aria-checked:bg-emerald-500 dark:aria-checked:text-emerald-950 dark:aria-checked:hover:bg-emerald-400",
    "",
    el(
      "span",
      "relative h-[18px] w-[30px] shrink-0 rounded-full bg-zinc-900/20 dark:bg-black/30 group-aria-checked:bg-black/20",
      el(
        "span",
        "absolute top-[3px] left-[3px] size-3 rounded-full bg-white shadow-sm transition-transform duration-150 group-aria-checked:translate-x-3",
      ),
    ),
    // Both labels share one grid cell so toggling never changes the width.
    el(
      "span",
      "grid",
      el("span", "col-start-1 row-start-1 invisible group-aria-checked:visible", "Live"),
      el("span", "col-start-1 row-start-1 group-aria-checked:invisible", "Paused"),
    ),
    toggleKbd,
  )
  toggle.setAttribute("role", "switch")

  const busyDot = el(
    "span",
    "size-2 shrink-0 rounded-full bg-sky-500 opacity-0 transition-opacity duration-150 data-busy:opacity-100 dark:bg-sky-400",
  )
  busyDot.title = "Replaying…"
  const busyPulse = el("span", "soft-pulse grid size-2 shrink-0 place-items-center", busyDot)
  const sumLabel = el("span", "truncate font-semibold")
  const sumSep = el("span", MUTED, "·")
  const sumCount = el("span", `shrink-0 tabular-nums ${MUTED}`)
  const summary = el(
    "div",
    "flex min-w-0 flex-1 items-center gap-1.5 px-1 text-[13px] whitespace-nowrap",
    busyPulse,
    sumLabel,
    sumSep,
    sumCount,
  )
  const grabBtn = button(ICON_BTN, "Add or remove windows (click each one, then Done)", icon("target", "size-[18px]"))
  const segGroup = el("div", "flex min-w-0 flex-1 items-center gap-1", toggle, summary, grabBtn)

  const chevron = button(
    `group ${ICON_BTN}`,
    "Windows & settings",
    icon("chevron", "size-4 transition-transform duration-150 group-aria-expanded:rotate-180"),
  )

  const bar = el(
    "div",
    "surface app-drag flex h-11 min-w-[340px] max-w-[440px] items-center gap-1 rounded-full py-1 pr-1 pl-1.5 whitespace-nowrap",
    grip,
    segStatus,
    segEmpty,
    segPick,
    segGroup,
    chevron,
  )

  // ---- Chip: one small notice (permission or update) between the pill and the panel ----

  // Compact layers are content-sized (measured, so the chip's width can be animated); the
  // update-progress layer fills the chip. Inactive layers are invisible and unfocusable.
  const LAYER =
    "invisible absolute inset-y-0 left-0 flex items-center gap-2 whitespace-nowrap opacity-0 transition-[opacity,visibility] duration-[180ms] data-active:visible data-active:opacity-100"
  const CHIP_BTN =
    "h-[22px] shrink-0 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap"
  const BTN_GO = `${CHIP_BTN} bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400`
  const BTN_NEUTRAL = `${CHIP_BTN} bg-zinc-900/[.07] text-zinc-700 hover:bg-zinc-900/[.12] active:bg-zinc-900/[.16] dark:bg-white/10 dark:text-zinc-300 dark:hover:bg-white/15 dark:active:bg-white/20`
  const BTN_SKY = `${CHIP_BTN} bg-sky-600 text-white hover:bg-sky-500 active:bg-sky-700 dark:bg-sky-500 dark:text-sky-950 dark:hover:bg-sky-400`

  // Update available / failed (same layout: dot, text, [What's new], Skip, Install/Retry).
  // "What's new" is only shown while available. It is a button styled as a link: the renderer
  // has no URL (and a strict CSP); main opens the release page.
  const updDot = el("span", "size-2 shrink-0 rounded-full bg-emerald-500")
  const updText = el("span", "min-w-0 flex-1")
  const notesLabel = el("span", "", "What's new")
  const notesBtn = button(
    "inline-flex h-[22px] shrink-0 items-center gap-0.5 rounded text-zinc-500 hover:text-zinc-900 hover:underline hover:underline-offset-2 dark:text-zinc-400 dark:hover:text-zinc-100",
    "",
    notesLabel,
    icon("external", "size-3"),
  )
  const skipBtn = button(
    "h-[22px] shrink-0 rounded-full px-2 text-xs font-semibold whitespace-nowrap text-zinc-500 hover:bg-zinc-900/[.07] hover:text-zinc-900 active:bg-zinc-900/[.12] dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100 dark:active:bg-white/15",
    "",
    "Skip",
  )
  const updBtn = button(BTN_GO, "Install")
  updBtn.append("Install")
  const layerUpdate = el(
    "div",
    `${LAYER} w-max pr-1 pl-3`,
    updDot,
    updText,
    notesBtn,
    el("div", "flex shrink-0 gap-0.5", skipBtn, updBtn),
  )

  // Update in progress
  const workTitle = el("div", "truncate text-[13px] font-semibold leading-[1.3]")
  const workSub = el("div", `truncate leading-[1.35] ${MUTED}`)
  const workFill = el("i", "block h-full rounded-full bg-emerald-500 transition-[width] duration-200")
  const workBar = el("div", "mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-900/10 dark:bg-white/10", workFill)
  workBar.setAttribute("role", "progressbar")
  workBar.setAttribute("aria-label", "Update progress")
  workBar.setAttribute("aria-valuemin", "0")
  workBar.setAttribute("aria-valuemax", "100")
  const layerWork = el(
    "div",
    `${LAYER} right-0 gap-2.5 pr-3.5 pl-2.5 data-active:delay-200`,
    appIcon("size-10 shrink-0"),
    el("div", "min-w-0 flex-1", workTitle, workSub, workBar),
  )

  // Permission: missing / waiting / granted
  const permText = el("span", "min-w-0 flex-1")
  const permBtn = button(BTN_SKY, "Open System Settings to grant the permission")
  permBtn.append("Open Settings")
  const layerPerm = el(
    "div",
    `${LAYER} w-max gap-2 pr-1 pl-[9px]`,
    el("span", "shrink-0 text-amber-600 dark:text-amber-300", icon("lock", "size-[15px]")),
    permText,
    permBtn,
  )
  const waitBtn = el(
    "button",
    "min-w-0 flex-1 text-left hover:underline",
    "Waiting for Accessibility permission…",
  )
  waitBtn.type = "button"
  waitBtn.title = "Open System Settings again"
  const layerWait = el(
    "div",
    `${LAYER} w-max gap-2 pr-3 pl-[9px]`,
    el(
      "span",
      "size-3.5 shrink-0 animate-[spin_.8s_linear_infinite] rounded-full border-2 border-zinc-900/15 border-t-sky-600 dark:border-white/20 dark:border-t-sky-300",
    ),
    waitBtn,
  )
  const layerOk = el(
    "div",
    `${LAYER} w-max gap-2 pr-3 pl-[9px]`,
    el("span", "shrink-0 text-emerald-600 dark:text-emerald-400", icon("check", "size-[15px]")),
    el("span", "min-w-0 flex-1", "Permission granted"),
  )

  const layers = [layerUpdate, layerWork, layerPerm, layerWait, layerOk]
  const chip = el(
    "div",
    "surface relative h-[30px] max-w-full shrink-0 overflow-hidden rounded-[15px] text-xs transition-[width,height,border-radius,opacity,border-width] duration-[380ms] ease-[cubic-bezier(.3,1.2,.4,1)] data-expanded:h-[62px] data-expanded:rounded-[20px] group-data-leaving:h-0 group-data-leaving:border-0 group-data-leaving:opacity-0",
    ...layers,
  )
  chip.setAttribute("aria-live", "polite")
  // width:0 + min-width:100% (like the panel): the chip never widens the root.
  const chipBox = el(
    "div",
    "group flex w-0 min-w-full justify-center transition-[margin] duration-[380ms] data-leaving:-mt-1.5",
    chip,
  )
  chipBox.hidden = true

  // ---- Panel ---------------------------------------------------------------

  const errorBox = el(
    "div",
    "mx-1 mb-1.5 rounded-lg bg-red-50 px-2.5 py-2 text-xs leading-snug break-words whitespace-normal text-red-800 dark:bg-red-950/70 dark:text-red-200",
  )
  const masterLine = el("div", `px-2 pt-1 pb-1 text-xs leading-snug whitespace-normal ${MUTED}`)
  const list = el("ul", "flex flex-col")
  const listEmpty = el("div", `px-2 py-2 text-xs whitespace-normal ${MUTED}`)

  /** One "label + segmented radio group" settings row (click offset, click delay). */
  const SEG_BTN =
    "h-6 min-w-9 rounded-md px-1.5 text-xs font-medium tabular-nums text-zinc-600 hover:text-zinc-900 aria-checked:bg-white aria-checked:text-zinc-900 aria-checked:shadow-sm dark:text-zinc-400 dark:hover:text-zinc-100 dark:aria-checked:bg-zinc-600 dark:aria-checked:text-white"
  function segmentedRow(
    name: string,
    hint: string,
    values: ReadonlyArray<number>,
    label: (v: number) => string,
    aria: (v: number) => string,
    pick: (v: number) => void,
  ): { readonly row: HTMLElement; readonly btns: ReadonlyArray<{ readonly v: number; readonly b: HTMLButtonElement }> } {
    const btns = values.map((v) => {
      const b = button(SEG_BTN, aria(v), label(v))
      b.setAttribute("role", "radio")
      b.addEventListener("click", () => pick(v))
      return { v, b }
    })
    const group = el("div", "inline-flex rounded-lg bg-zinc-900/[.06] p-0.5 dark:bg-white/[.08]", ...btns.map((x) => x.b))
    group.setAttribute("role", "radiogroup")
    group.setAttribute("aria-label", name)
    // The unit is in each option's label/tooltip: "Click offset (px)" plus six segments
    // would not fit the panel at the bar's minimum width.
    const nameEl = el("span", "flex-1", name)
    nameEl.title = hint
    return { row: el("div", "flex h-9 items-center gap-2 px-2", nameEl, group), btns }
  }

  const offset = segmentedRow(
    "Click offset",
    "Shift each other window's click by a random amount of up to this many pixels",
    CLICK_OFFSETS,
    clickOffsetLabel,
    (px) => (px === 0 ? "Click offset off (same spot in every window)" : `Click offset ${px} pixels`),
    (px) => api.setClickOffset(px),
  )
  const delay = segmentedRow(
    "Click delay",
    "Wait a random time of up to this many milliseconds before replaying into each other window",
    CLICK_DELAYS,
    clickDelayLabel,
    (ms) => (ms === 0 ? "Click delay off (no pause between windows)" : `Click delay ${ms} milliseconds`),
    (ms) => api.setClickDelay(ms),
  )

  const TEXT_BTN =
    "h-7 rounded-md px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-900/[.07] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
  const hotkeyHint = el("span", `flex-1 truncate px-2 text-xs ${MUTED}`)
  const forgetBtn = button(TEXT_BTN, "Remove all windows from the group", "Forget group")
  const quitBtn = button(
    TEXT_BTN + " hover:!text-red-700 dark:hover:!text-red-300",
    "Quit Clickered",
    "Quit",
  )

  // Pre-release updates switch, and the "skipped" line under it.
  const preSwitch = smallSwitch("Pre-release updates")
  const preName = el("span", "flex-1", "Pre-release updates")
  preName.title = "Also offer release candidates and betas. Off: only full releases."
  const preRow = el("div", "flex h-9 items-center gap-2 px-2", preName, preSwitch)
  const skippedText = el("span", "flex-1")
  const unskipBtn = button(
    "-mr-1.5 h-[22px] shrink-0 rounded-md px-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-900/[.07] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100",
    "",
    "Show again",
  )
  const skippedRow = el("div", `mt-0.5 flex h-[26px] items-center gap-2 px-2 text-xs ${MUTED}`, skippedText, unskipBtn)

  const divider = (): HTMLElement => el("div", "mx-2 my-1 h-px bg-zinc-900/10 dark:bg-white/10")
  const listSection = el("div", "", masterLine, list, listEmpty)
  const listDivider = divider()

  const panel = el(
    "div",
    // width:0 + min-width:100% -> the panel never widens the root; it takes the bar's width.
    "surface w-0 min-w-full overflow-hidden rounded-2xl p-1.5 text-[13px] whitespace-nowrap",
    errorBox,
    listSection,
    listDivider,
    offset.row,
    delay.row,
    divider(),
    preRow,
    skippedRow,
    divider(),
    el("div", "flex items-center gap-0.5", hotkeyHint, forgetBtn, quitBtn),
  )

  const root = el("div", "replay-fade inline-flex w-max flex-col gap-1.5 p-2.5 font-sans antialiased", bar, chipBox, panel)
  app.replaceChildren(root)

  // ---- Window rows -------------------------------------------------------

  interface Row {
    readonly li: HTMLLIElement
    readonly idx: HTMLElement
    readonly title: HTMLElement
    readonly source: HTMLElement
    readonly pin: HTMLButtonElement
    readonly inc: HTMLButtonElement
  }
  let rows = new Map<WindowId, Row>()
  let rowKey = ""

  function makeRow(id: WindowId): Row {
    const idx = el("span", `w-6 shrink-0 text-xs font-semibold tabular-nums ${MUTED}`)
    const title = el("span", "min-w-0 flex-1 truncate group-data-excluded:text-zinc-400 dark:group-data-excluded:text-zinc-500")
    const source = el(
      "span",
      "shrink-0 rounded px-1 text-[10px] font-semibold tracking-wide text-emerald-700 uppercase dark:text-emerald-400",
      "source",
    )
    source.title = "Last window you clicked in (the current source)"
    const pin = button(
      "grid size-6 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-zinc-900/[.07] hover:text-zinc-700 disabled:opacity-30 disabled:hover:bg-transparent aria-pressed:bg-amber-100 aria-pressed:text-amber-600 dark:text-zinc-500 dark:hover:bg-white/10 dark:hover:text-zinc-200 dark:aria-pressed:bg-amber-400/15 dark:aria-pressed:text-amber-300",
      "",
      icon("crown", "size-3.5"),
    )
    const inc = smallSwitch("Include")
    pin.addEventListener("click", () => {
      if (!state) return
      const pinned = state.masterMode === "pinned" && state.masterId === id
      api.setMaster(pinned ? null : id)
    })
    inc.addEventListener("click", () => {
      const w = state?.windows.find((x) => x.id === id)
      if (w) api.setIncluded(id, !w.included)
    })
    const li = el("li", "group flex h-8 items-center gap-2 rounded-lg px-2 hover:bg-zinc-900/[.04] dark:hover:bg-white/[.05]", idx, title, source, pin, inc)
    return { li, idx, title, source, pin, inc }
  }

  function patchRow(r: Row, w: GroupWindow, s: AppState): void {
    const pinned = s.masterMode === "pinned" && s.masterId === w.id
    setText(r.idx, `#${w.index}`)
    setText(r.title, w.title || "(untitled)")
    setAttr(r.title, "title", w.title)
    setFlag(r.li, "data-excluded", !w.included)
    show(r.source, s.masterMode === "auto" && w.isMaster)
    setAttr(r.pin, "aria-pressed", pinned ? "true" : "false")
    r.pin.disabled = !pinned && !w.included
    const pinLabel = pinned ? `#${w.index} is the master — click to return to auto` : `Pin #${w.index} as the only master`
    setAttr(r.pin, "title", pinLabel)
    setAttr(r.pin, "aria-label", pinLabel)
    setAttr(r.inc, "aria-checked", w.included ? "true" : "false")
    const incLabel = w.included ? `#${w.index} included — click to exclude` : `#${w.index} excluded — click to include`
    setAttr(r.inc, "title", incLabel)
    setAttr(r.inc, "aria-label", incLabel)
  }

  function renderRows(s: AppState): void {
    const key = s.windows.map((w) => w.id).join(",")
    if (key !== rowKey) {
      const next = new Map<WindowId, Row>()
      for (const w of s.windows) next.set(w.id, rows.get(w.id) ?? makeRow(w.id))
      // Re-append in order; existing nodes are moved, not recreated (keeps focus where possible).
      list.replaceChildren(...[...next.values()].map((r) => r.li))
      rows = next
      rowKey = key
    }
    for (const w of s.windows) {
      const r = rows.get(w.id)
      if (r) patchRow(r, w, s)
    }
  }

  // ---- Chip: state and render --------------------------------------------

  let permPhase: PermissionPhase = "idle"
  let permPrev: AppState["permission"] | null = null
  let permLeaving = false
  let permTimers: ReturnType<typeof setTimeout>[] = []

  function applyState(s: AppState): void {
    const next = permissionPhaseAfter(permPhase, permPrev, s.permission)
    permPrev = s.permission
    if (next === "granted" && permPhase !== "granted") {
      // Show "Permission granted" for a moment, then collapse the chip away.
      permTimers.push(
        setTimeout(() => {
          permLeaving = true
          renderChip()
        }, 1700),
        setTimeout(() => {
          permPhase = "idle"
          permLeaving = false
          renderChip()
        }, 2100),
      )
    } else if (next !== "granted" && permPhase === "granted") {
      permTimers.forEach(clearTimeout)
      permTimers = []
      permLeaving = false
    }
    permPhase = next
    state = s
    render()
  }

  const setLayers = (active: HTMLElement | null): void => {
    for (const l of layers) setFlag(l, "data-active", l === active)
  }

  function renderChip(): void {
    const view = chipView(update, state, permPhase)
    const visible = view.kind !== "none"
    const wasHidden = chipBox.hidden
    show(chipBox, visible)
    if (!visible) return
    if (wasHidden) {
      chip.classList.remove("panel-in")
      void chip.offsetWidth
      chip.classList.add("panel-in")
    }
    setFlag(chipBox, "data-leaving", permLeaving)
    setFlag(chip, "data-expanded", view.kind === "update-progress")

    let layer: HTMLElement
    switch (view.kind) {
      case "update-progress": {
        layer = layerWork
        setText(workTitle, view.title)
        setText(workSub, view.sub)
        const determinate = view.progress !== null
        workFill.className = `block h-full rounded-full bg-emerald-500 ${determinate ? "transition-[width] duration-200" : "bar-slide"}`
        workFill.style.width = determinate ? `${view.progress}%` : "35%"
        setAttr(workBar, "aria-valuenow", determinate ? String(view.progress) : null)
        setAttr(workBar, "aria-valuetext", determinate ? null : view.sub)
        break
      }
      case "update-available":
      case "update-failed": {
        layer = layerUpdate
        const failed = view.kind === "update-failed"
        setText(updText, view.text)
        updDot.className = `size-2 shrink-0 rounded-full ${failed ? "bg-red-500" : "bg-emerald-500"}`
        const label = failed ? "Retry" : "Install"
        if (updBtn.textContent !== label) {
          updBtn.textContent = label
          updBtn.className = failed ? BTN_NEUTRAL : BTN_GO
        }
        if (failed) setAttr(layerUpdate, "title", view.message)
        setAttr(updBtn, "title", failed ? "Download and install the update again" : "Download and install the update")
        setAttr(updBtn, "aria-label", failed ? "Retry the update" : "Install the update")
        // The width is measured below, so these must be settled first.
        show(notesBtn, !failed)
        show(notesLabel, true)
        const v = view.version
        setAttr(skipBtn, "title", `Skip ${v}: no update notice until a newer version is released`)
        setAttr(skipBtn, "aria-label", `Skip ${v}`)
        if (view.kind === "update-available") {
          setAttr(notesBtn, "title", `Open the ${v} release notes on GitHub`)
          setAttr(notesBtn, "aria-label", `What's new in ${v}`)
          updDot.className = `size-2 shrink-0 rounded-full ${view.prerelease ? "bg-amber-500 dark:bg-amber-400" : "bg-emerald-500"}`
          setAttr(layerUpdate, "title", view.prerelease ? "Pre-release version" : null)
        }
        break
      }
      case "permission-missing":
        layer = layerPerm
        setText(permText, view.text)
        break
      case "permission-waiting":
        layer = layerWait
        break
      default:
        layer = layerOk
    }
    setLayers(layer)
    // A long version ("1.10.0-rc.1") can make the chip wider than the bar at its narrowest:
    // the link then keeps only its arrow (its tooltip and accessible name stay).
    if (layer === layerUpdate && layer.offsetWidth + 2 > chipBox.clientWidth) show(notesLabel, false)
    // Compact chips are as wide as their content; the progress chip as wide as the bar.
    const width = view.kind === "update-progress" ? "100%" : `${layer.offsetWidth + 2}px`
    if (chip.style.width !== width) chip.style.width = width
  }

  // ---- Render ------------------------------------------------------------

  type Mode = "starting" | "error" | "picking" | "empty" | "group"
  function modeOf(s: AppState | null): Mode {
    if (!s) return "starting"
    if (s.picking) return "picking"
    if (s.helper === "error") return "error"
    if (s.helper === "starting") return "starting"
    if (s.groupClass === null) return "empty"
    return "group"
  }

  /** The startup error the panel was last opened for (see render). */
  let shownStartupError: string | null = null
  let autoOpened = false

  function render(): void {
    const s = state
    const mode = modeOf(s)
    // An error before `ready` is something the user must act on while the helper keeps
    // waiting (macOS: grant Accessibility). Open the panel to show the full text, and
    // close it again once the helper is ready.
    const startupError = mode === "starting" ? (s?.helperError ?? null) : null
    if (startupError !== shownStartupError) {
      // A missing permission is carried by the chip, so it does not open the panel.
      if (startupError !== null) {
        if (s?.permission !== "missing") {
          expanded = true
          autoOpened = true
        }
      } else if (shownStartupError !== null && autoOpened) {
        expanded = false
        autoOpened = false
      }
      shownStartupError = startupError
    }
    const alert = mode === "error" || startupError !== null

    show(segStatus, mode === "starting" || mode === "error")
    show(segEmpty, mode === "empty")
    show(segPick, mode === "picking")
    show(segGroup, mode === "group")
    show(chevron, mode !== "picking")
    if (mode === "picking" && expanded) expanded = false
    if (s && mode === "picking") {
      const n = s.windows.length
      setText(pickTitle, n === 0 ? "Click each window…" : `${n} selected · click more`)
    }

    // status
    statusIcon.className =
      alert
        ? "grid size-6 shrink-0 place-items-center rounded-full bg-red-600 text-white dark:bg-red-500"
        : "hidden"
    if (mode === "error") {
      setText(statusText, "Helper failed")
      statusText.className = "truncate font-semibold text-red-700 dark:text-red-400"
      setAttr(segStatus, "title", s?.helperError ?? "The input helper stopped")
    } else if (startupError !== null) {
      setText(statusText, "Action needed")
      statusText.className = "truncate font-semibold text-red-700 dark:text-red-400"
      setAttr(segStatus, "title", startupError)
    } else {
      setText(statusText, "Starting…")
      statusText.className = `truncate ${MUTED}`
      setAttr(segStatus, "title", null)
    }

    renderChip()

    // panel
    show(panel, expanded)
    setAttr(chevron, "aria-expanded", expanded ? "true" : "false")

    setAttr(preSwitch, "aria-checked", update.prereleases ? "true" : "false")
    setAttr(
      preSwitch,
      "title",
      update.prereleases
        ? "On: release candidates and betas are offered too"
        : "Off: only full releases are offered",
    )
    const skipped = update.status === "skipped"
    show(skippedRow, skipped)
    if (update.status === "skipped") {
      setText(skippedText, `Update ${update.version} skipped`)
      const tipShow = `Show the ${update.version} update notice again`
      setAttr(unskipBtn, "title", tipShow)
      setAttr(unskipBtn, "aria-label", `Show update ${update.version} again`)
    }
    if (!s) return

    const hk = formatHotkey(s.hotkey)
    // toggle
    setAttr(toggle, "aria-checked", s.enabled ? "true" : "false")
    setText(toggleKbd, hk)
    const tip = s.enabled
      ? `Replicating clicks — click to pause${hk ? ` (${hk})` : ""}`
      : `Paused — click to replicate again${hk ? ` (${hk})` : ""}`
    setAttr(toggle, "title", tip)
    setAttr(toggle, "aria-label", tip)
    show(toggleKbd, hk !== "")

    // summary
    const name = groupName(s)
    if (s.windows.length === 0) {
      setText(sumLabel, `Waiting for ${name} windows…`)
      sumLabel.className = `truncate font-normal ${MUTED}`
      show(sumSep, false)
      show(sumCount, false)
    } else {
      setText(sumLabel, name)
      sumLabel.className = "truncate font-semibold"
      show(sumSep, true)
      show(sumCount, true)
      setText(sumCount, countText(s))
    }
    setAttr(summary, "title", s.groupClass ? `Group: ${s.groupClass}` : null)
    setFlag(busyDot, "data-busy", s.busy)
    // Main makes the window click-through during replays; fade it so that's visible.
    setFlag(root, "data-replaying", s.busy)

    // panel content
    show(errorBox, s.helper === "error" || startupError !== null)
    setText(
      errorBox,
      startupError ?? (s.helperError ? `Helper error: ${s.helperError}` : "The input helper stopped."),
    )

    const hasGroup = s.groupClass !== null
    show(listSection, hasGroup || s.windows.length > 0)
    show(listDivider, hasGroup || s.windows.length > 0)
    renderRows(s)
    show(list, s.windows.length > 0)
    show(listEmpty, s.windows.length === 0)
    setText(listEmpty, `No ${groupName(s)} windows open. They join automatically when they appear.`)

    let master: string
    if (s.masterMode === "pinned") {
      const m = s.windows.find((w) => w.id === s.masterId)
      master = m ? `Master: #${m.index} pinned — click the crown again for auto` : "Master: pinned window is closed"
    } else {
      master = "Master: auto — click in any window"
    }
    setText(masterLine, master)
    show(masterLine, s.windows.length > 0)

    for (const { v, b } of offset.btns) setAttr(b, "aria-checked", v === s.clickOffset ? "true" : "false")
    for (const { v, b } of delay.btns) setAttr(b, "aria-checked", v === s.clickDelay ? "true" : "false")

    setText(hotkeyHint, hk ? `${hk} toggles` : "")
    show(forgetBtn, hasGroup)
  }

  // ---- Events --------------------------------------------------------------

  toggle.addEventListener("click", () => {
    if (state) api.setEnabled(!state.enabled)
  })
  ctaBtn.addEventListener("click", () => api.startPick())
  grabBtn.addEventListener("click", () => api.startPick())
  pickCancel.addEventListener("click", () => api.cancelPick())
  chevron.addEventListener("click", () => {
    expanded = !expanded
    if (expanded) {
      panel.classList.remove("panel-in")
      void panel.offsetWidth
      panel.classList.add("panel-in")
    }
    render()
  })
  updBtn.addEventListener("click", () => api.installUpdate())
  skipBtn.addEventListener("click", () => api.skipUpdate())
  notesBtn.addEventListener("click", () => api.openReleaseNotes())
  unskipBtn.addEventListener("click", () => api.unskipUpdate())
  preSwitch.addEventListener("click", () => api.setPrereleaseUpdates(!update.prereleases))
  permBtn.addEventListener("click", () => {
    permPhase = "waiting"
    api.openPermissionSettings()
    renderChip()
  })
  waitBtn.addEventListener("click", () => api.openPermissionSettings())
  forgetBtn.addEventListener("click", () => api.clearGroup())
  quitBtn.addEventListener("click", () => api.quit())

  window.addEventListener("contextmenu", (e) => {
    e.preventDefault()
    if (state?.picking) api.cancelPick()
  })
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return
    if (state?.picking) api.cancelPick()
    else if (expanded) {
      expanded = false
      render()
    }
  })

  // ---- Sizing: the Electron window always exactly fits the root ------------

  let lastW = 0
  let lastH = 0
  const report = (): void => {
    const r = root.getBoundingClientRect()
    const w = Math.ceil(r.width)
    const h = Math.ceil(r.height)
    if (w === lastW && h === lastH) return
    lastW = w
    lastH = h
    api.setSize(w, h)
  }
  new ResizeObserver(report).observe(root)

  render()
  report()

  api.onState(applyState)
  void api.getState().then((s) => {
    if (state === null) applyState(s)
  })
  let updateSeen = false
  api.onUpdate((u) => {
    updateSeen = true
    update = u
    render()
  })
  void api.getUpdate().then((u) => {
    if (!updateSeen) {
      update = u
      render()
    }
  })
}

void resolveApi().then((api) => {
  if (api) {
    start(api)
    return
  }
  const app = document.getElementById("app") ?? document.body
  app.innerHTML = ""
  app.append(
    el(
      "div",
      "inline-flex p-2.5",
      el("div", "surface rounded-full px-4 py-2 text-[13px] text-red-700 dark:text-red-400", "Clickered: preload API missing"),
    ),
  )
})
