import streamDeck, { DialAction } from "@elgato/streamdeck";

class Knob extends DialAction {
  async onDialRotate(ev) {
    ev.action.setTitle("knob");
  }
}

streamDeck.action("com.ld.dialonly.knob").register(new Knob());
streamDeck.connect();
