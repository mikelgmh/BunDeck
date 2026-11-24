import streamDeck, { DialAction, SingletonAction } from "@elgato/streamdeck";

streamDeck.action("com.ld.mixed.tap").onKeyDown((ev) => {
  ev.action.setTitle("tap!");
});

class Knob extends DialAction {}
streamDeck.action("com.ld.mixed.knob").register(new Knob());

streamDeck.connect();
