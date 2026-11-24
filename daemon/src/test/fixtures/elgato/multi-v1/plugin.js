import streamDeck from "@elgato/streamdeck";

for (const name of ["alpha", "beta"]) {
  const uuid = `com.ld.multi.${name}`;
  streamDeck.action(uuid).onWillAppear((ev) => ev.action.setTitle(name));
  streamDeck.action(uuid).onKeyDown((ev) => ev.action.setTitle(`${name}!`));
}

streamDeck.connect();
