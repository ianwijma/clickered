// Stand-in for resources/clickered-helper in tests. Speaks the stdout side of the
// protocol, logs every stdin line to $FAKE_LOG, injects nothing anywhere.
//
// env: FAKE_LOG (required)      file that receives one line per stdin command (+ "EOF")
//      FAKE_WINDOWS             JSON array of HelperWindow
//      FAKE_VERSION             protocol version announced in `ready` (default 2)
//      FAKE_STARTUP_ERROR       emit this `error` msg before `ready` (like the macOS helper
//                               waiting for the Accessibility permission)
//      FAKE_READY_DELAY         ms before `ready` + the first `windows` (default 0)
//      FAKE_EVENTS              JSON array of helper messages, emitted after startup
//      FAKE_EVENTS_DELAY        ms before the first event (default 80), 5 ms apart
//      FAKE_PICK                comma-separated window ids answered to successive `pick`s (then 0)
//      FAKE_SEQ_DELAY           ms before answering a seq (default 5)
//      FAKE_SEQ_HANG=1          never answer a seq until `abort`
//      FAKE_ESC_ON_SEQ          ms into a seq: emit `esc` then `done ok:false` in one write
//                               (a physical Escape aborting the replay, like the real helper)
//      FAKE_EXIT_AFTER          exit(3) after this many ms
//      FAKE_IGNORE_EOF=1        keep running after stdin closes (tests SIGKILL fallback)
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const log = (line) => appendFileSync(process.env.FAKE_LOG, line + "\n")
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
const windows = JSON.parse(process.env.FAKE_WINDOWS ?? "[]")
const sendWindows = () => out({ t: "windows", active: windows[0]?.id ?? 0, list: windows })

if (process.env.FAKE_STARTUP_ERROR) out({ t: "error", msg: process.env.FAKE_STARTUP_ERROR })
const announce = () => {
  out({ t: "ready", version: Number(process.env.FAKE_VERSION ?? 2) })
  sendWindows()
}
if (process.env.FAKE_READY_DELAY) setTimeout(announce, Number(process.env.FAKE_READY_DELAY))
else announce()
process.stdout.write("this line is not json and must be ignored\n")
process.stderr.write("fake helper up\n")

const events = JSON.parse(process.env.FAKE_EVENTS ?? "[]")
events.forEach((e, i) => setTimeout(() => out(e), Number(process.env.FAKE_EVENTS_DELAY ?? 80) + i * 5))

if (process.env.FAKE_EXIT_AFTER) setTimeout(() => process.exit(3), Number(process.env.FAKE_EXIT_AFTER))

const picks = (process.env.FAKE_PICK ?? "").split(",").filter(Boolean)
let hanging = null
createInterface({ input: process.stdin })
  .on("line", (line) => {
    log(line)
    const [cmd, arg] = line.split(" ")
    if (cmd === "list") sendWindows()
    else if (cmd === "pick") setTimeout(() => out({ t: "picked", win: Number(picks.shift() ?? 0) }), 10)
    else if (cmd === "pickcancel") out({ t: "picked", win: 0 })
    else if (cmd === "seq") {
      const id = Number(arg)
      if (process.env.FAKE_ESC_ON_SEQ)
        setTimeout(
          () =>
            process.stdout.write(
              JSON.stringify({ t: "esc", time: 1 }) + "\n" + JSON.stringify({ t: "done", id, ok: false }) + "\n",
            ),
          Number(process.env.FAKE_ESC_ON_SEQ),
        )
      else if (process.env.FAKE_SEQ_HANG === "1") hanging = id
      else setTimeout(() => out({ t: "done", id, ok: true }), Number(process.env.FAKE_SEQ_DELAY ?? 5))
    } else if (cmd === "abort" && hanging !== null) {
      out({ t: "done", id: hanging, ok: false })
      hanging = null
    }
  })
  .on("close", () => {
    log("EOF")
    if (process.env.FAKE_IGNORE_EOF === "1") setInterval(() => {}, 1000)
    else process.exit(0)
  })
