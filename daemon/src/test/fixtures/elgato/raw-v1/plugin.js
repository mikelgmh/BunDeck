// Fixture raw mínima (estilo AUS-UV): protocolo WebSocket en crudo, sin SDK.
// `ws` lo resuelve el stub del shim contra el socket virtual en-Worker.
import WebSocket from "ws";

const PLUGIN_UUID = "com.ld.raw";

const ws = new WebSocket("ws://127.0.0.1:0");

ws.on("open", () => {
  ws.send(JSON.stringify({ event: "registerPlugin", uuid: PLUGIN_UUID }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.event === "keyDown") {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: "setTitle", context: msg.context, payload: { title: "raw!", target: 0 } }));
      ws.send(JSON.stringify({ event: "getSettings", context: msg.context }));
    }
  }
  if (msg.event === "didReceiveSettings") {
    // Eco de settings: confirma el ciclo host→plugin→host.
    ws.send(JSON.stringify({
      event: "setSettings",
      context: msg.context,
      payload: { ...(msg.payload.settings ?? {}), echoed: true },
    }));
  }
});
