import { action, streamDeck } from "@elgato/streamdeck";

let lastSeen = null;

action("com.ld.clocksettings.tick").onDidReceiveSettings((ev) => {
  lastSeen = { ...ev.payload.settings };
});

action("com.ld.clocksettings.tick").onKeyDown((ev) => {
  ev.action.setTitle(String(ev.payload.settings.interval ?? "?"));
});

action("com.ld.clocksettings.tick").onKeyUp((ev) => {
  ev.action.sendToPropertyInspector({ echo: ev.payload.settings });
});

streamDeck.connect();
