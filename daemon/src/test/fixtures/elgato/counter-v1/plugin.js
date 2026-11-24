import streamDeck, { SingletonAction } from "@elgato/streamdeck";

class Counter extends SingletonAction {
  async onWillAppear(ev) {
    ev.action.setTitle(String(ev.payload.settings.count ?? 0));
  }
  async onKeyDown(ev) {
    const n = Number(ev.payload.settings.count ?? 0) + 1;
    await ev.action.setSettings({ count: n });
    ev.action.setTitle(String(n));
    ev.action.setState(n % 2);
  }
}

streamDeck.action("com.ld.counter.count").register(new Counter());
streamDeck.connect();
