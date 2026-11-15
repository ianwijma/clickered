import "./styles.css"
import { CLICK_DELAYS, CLICK_OFFSETS, type AppState, type ClickeredApi, type GroupWindow } from "@shared/ipc"
import type { WindowId } from "@shared/protocol"
import { clickDelayLabel, clickOffsetLabel, countText, formatHotkey, groupName } from "./format"
import { icon } from "./icons"

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
    el("div", "flex items-center gap-0.5", hotkeyHint, forgetBtn, quitBtn),
  )

  const root = el("div", "replay-fade inline-flex w-max flex-col gap-1.5 p-2.5 font-sans antialiased", bar, panel)
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

  function render(): void {
    const s = state
    const mode = modeOf(s)
    // An error before `ready` is something the user must act on while the helper keeps
    // waiting (macOS: grant Accessibility). Open the panel to show the full text, and
    // close it again once the helper is ready.
    const startupError = mode === "starting" ? (s?.helperError ?? null) : null
    if (startupError !== shownStartupError) {
      if (startupError !== null) expanded = true
      else if (shownStartupError !== null) expanded = false
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

    // panel
    show(panel, expanded)
    setAttr(chevron, "aria-expanded", expanded ? "true" : "false")
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

  api.onState((s) => {
    state = s
    render()
  })
  void api.getState().then((s) => {
    if (state === null) {
      state = s
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
