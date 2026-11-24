import streamDeck from "@elgato/streamdeck";

let n = 0;
streamDeck.action("com.ld.alert.flash").onKeyDown((ev) => {
  n += 1;
  if (n % 2 === 1) ev.action.showAlert();
  else ev.action.showOk();
});

streamDeck.connect();
