import { describe, expect, it } from "vitest"
import { encodeCommand, encodeOp } from "./protocol"

describe("encodeOp", () => {
  it("serialises every op", () => {
    expect(encodeOp({ op: "f", win: 42 })).toBe("f 42")
    expect(encodeOp({ op: "m", win: 7, fx: 0.5, fy: 1 })).toBe("m 7 0.50000 1")
    expect(encodeOp({ op: "d", button: 1 })).toBe("d 1")
    expect(encodeOp({ op: "u", button: 3 })).toBe("u 3")
    expect(encodeOp({ op: "kd", keycode: 38 })).toBe("kd 38")
    expect(encodeOp({ op: "ku", keycode: 38 })).toBe("ku 38")
    expect(encodeOp({ op: "w", x: 10.4, y: 20.6 })).toBe("w 10 21")
  })

  it("rounds fractions to 5 decimals and keeps integers bare", () => {
    expect(encodeOp({ op: "m", win: 1, fx: 1 / 3, fy: -0.000001 })).toBe("m 1 0.33333 -0.00000")
    expect(encodeOp({ op: "m", win: 1, fx: 0, fy: 2 })).toBe("m 1 0 2")
  })

  it("rounds sleeps and never emits a negative one", () => {
    expect(encodeOp({ op: "s", ms: 12.6 })).toBe("s 13")
    expect(encodeOp({ op: "s", ms: -5 })).toBe("s 0")
  })
})

describe("encodeCommand", () => {
  it("serialises the bare commands", () => {
    expect(encodeCommand({ c: "list" })).toBe("list")
    expect(encodeCommand({ c: "pick" })).toBe("pick")
    expect(encodeCommand({ c: "pickcancel" })).toBe("pickcancel")
    expect(encodeCommand({ c: "abort" })).toBe("abort")
    expect(encodeCommand({ c: "keys", on: true })).toBe("keys 1")
    expect(encodeCommand({ c: "keys", on: false })).toBe("keys 0")
  })

  it("joins seq ops with ';' on a single line", () => {
    const line = encodeCommand({
      c: "seq",
      id: 9,
      ops: [
        { op: "m", win: 5, fx: 0.25, fy: 0.75 },
        { op: "d", button: 1 },
        { op: "s", ms: 35 },
        { op: "u", button: 1 },
      ],
    })
    expect(line).toBe("seq 9 m 5 0.25000 0.75000;d 1;s 35;u 1")
    expect(line).not.toContain("\n")
  })
})
