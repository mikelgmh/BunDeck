import streamDeck from "@elgato/streamdeck";

streamDeck.action("com.ld.image.badge").onKeyDown((ev) => {
  ev.action.setImage("imgs/icon.png");
  ev.action.setTitle("img");
});

streamDeck.connect();
