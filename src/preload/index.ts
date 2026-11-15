import { contextBridge, ipcRenderer } from "electron"
import { IPC, type AppState, type ClickeredApi, type IpcCommand, type UpdateState } from "@shared/ipc"

const send = (cmd: IpcCommand): void => ipcRenderer.send(IPC.command, cmd)

const api: ClickeredApi = {
  getState: () => ipcRenderer.invoke(IPC.getState) as Promise<AppState>,
  onState: (listener) => {
    const handler = (_e: unknown, state: AppState): void => listener(state)
    ipcRenderer.on(IPC.state, handler)
    return () => ipcRenderer.removeListener(IPC.state, handler)
  },
  setEnabled: (enabled) => send({ c: "setEnabled", enabled }),
  startPick: () => send({ c: "startPick" }),
  cancelPick: () => send({ c: "cancelPick" }),
  clearGroup: () => send({ c: "clearGroup" }),
  setIncluded: (id, included) => send({ c: "setIncluded", id, included }),
  setMaster: (id) => send({ c: "setMaster", id }),
  setClickOffset: (px) => send({ c: "setClickOffset", px }),
  setClickDelay: (ms) => send({ c: "setClickDelay", ms }),
  setSize: (width, height) => send({ c: "setSize", width, height }),
  getUpdate: () => ipcRenderer.invoke(IPC.getUpdate) as Promise<UpdateState>,
  onUpdate: (listener) => {
    const handler = (_e: unknown, update: UpdateState): void => listener(update)
    ipcRenderer.on(IPC.update, handler)
    return () => ipcRenderer.removeListener(IPC.update, handler)
  },
  installUpdate: () => send({ c: "installUpdate" }),
  openPermissionSettings: () => send({ c: "openPermissionSettings" }),
  quit: () => send({ c: "quit" }),
}

contextBridge.exposeInMainWorld("clickered", api)
