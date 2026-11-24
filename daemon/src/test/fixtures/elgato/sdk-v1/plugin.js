import streamDeck from "@elgato/streamdeck";

streamDeck.action("com.ld.sdk.ping").onWillAppear((ev) => {
  ev.action.setTitle("ready");
});
streamDeck.action("com.ld.sdk.ping").onKeyDown((ev) => {
  ev.action.setTitle("pong");
  ev.action.setState(1);
});
streamDeck.action("com.ld.sdk.ping").onKeyUp((ev) => {
  ev.action.setState(0);
});

streamDeck.connect();
