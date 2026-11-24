import streamDeck from "@elgato/streamdeck";

streamDeck.action("com.ld.openurl.open").onKeyDown(async (ev) => {
  await streamDeck.system.openUrl("https://example.com/ld");
  ev.action.setTitle("open");
});

streamDeck.connect();
