# Security policy — BunDeck

BunDeck is a **local-first automation tool with a real attack surface**.
The daemon can launch apps, run scripts and shell commands, open local
ports, and — only when you opt in — talk to the LAN or the public relay.
This page states the model plainly so you can decide what to trust.

## Scope: what the daemon can do

- **Execute things on your machine:** launch applications, run scripts
  and shell commands, send keys/media events, drive OBS / Spotify /
  Home Assistant integrations, and control Elgato Stream Deck hardware.
  A button press is arbitrary local code execution **by design**.
- **Open ports on your machine:** API (`3001`), WebSocket (`3003`) and
  embedded frontend (`3002`) by default. See `README.md`
  (“Ports, bind and data”).
- **Talk on the LAN, only with opt-in:** loopback-only by default;
  LAN access requires `BUNDECK_BIND_LAN=1` / `BUNDECK_BIND=0.0.0.0`
  (set by `dev.sh`, the Rust launcher and the dev host when needed).
- **Talk to the public relay, E2E-encrypted:** remote access and the
  internet-exposed UI tunnel go through `wss://relay.bundeck.app`
  by default (old host `wss://bundeck.mikelgranero.com` still works
  as a fallback). Payloads are NaCl `box` (X25519 + XSalsa20-Poly1305);
  the relay only routes opaque envelopes. See “Relay privacy” below
  and `relay/README.md`.

## Reporting a vulnerability

- **Contact:** open a **private security advisory** on GitHub
  (`https://github.com/mikelgmh/BunDeck/security/advisories/new`)
  or email the maintainer via the address listed on that page.
  Do **not** open a public issue for a suspected vulnerability.
- **What to include:** affected version (`GET /api/v1/version`),
  platform, steps to reproduce, and what you expected to happen.
- **What to expect:** confirmation of receipt within a few days,
  status updates while a fix is prepared, and credit in the release
  notes if you want it. There is no bug-bounty program; this is a
  small open-source project and response times are best-effort.

## LAN policy: loopback-only, QR invitations

- **Default is loopback-only shutdown:** the daemon binds to
  `127.0.0.1`. Anything on your LAN (phone remote, QR pairing)
  only works after an explicit opt-in.
- **LAN access is invite-only:** guests need a single-use invitation
  code (shown as QR on the host). Invitation management endpoints
  are loopback-only — a guest can never mint new invites.
- **Only the redeem endpoint is rate-limited** (`10` attempts/min/IP,
  `429 LAN_RATE_LIMITED`). The local API itself is throttle-free by
  design on loopback: rate-limiting your own machine would only add
  failure modes, not security.

## External plugins are arbitrary code

- External plugins (`<data>/plugins/<id>/` with `manifest.json` +
  `main.js`) run with the same OS privileges as the daemon.
- The manifest is validated and the plugin runs in a sandbox
  (`daemon/src/plugin-system/`), but **treat every external plugin
  as arbitrary code from its author**: only install plugins from
  sources you trust, and review updates the same way.
- Built-in plugins ship with the daemon and are versioned with it.

## Loopback has no auth, by design

- Requests from `127.0.0.1` / `::1` are fully trusted: **any local
  process or local user can control the daemon** (execute actions,
  read settings, shut it down).
- That is a deliberate trade-off for a local automation tool, not an
  oversight — but it means: don’t run untrusted local software next
  to your automation host, and don’t expose the ports to networks
  you don’t control.

## Relay privacy summary

- **Relay mode** (default, via `relay.bundeck.app`): the operator
  can see routing metadata — which device IDs are online, source
  IPs, connection times, message sizes and timing — but **never
  message contents**: payloads are end-to-end encrypted and the
  relay forwards opaque envelopes it cannot decrypt.
- **Direct / P2P mode:** once peers establish a direct channel,
  traffic never passes through the relay at all.
- **Opt out:** set `remote.relay.url` to `off` (also accepts `none` /
  `disabled`) to disable the relay entirely; local and LAN features
  keep working. The old host `wss://bundeck.mikelgranero.com`
  remains valid as a fallback.

## Supply chain: what is (and isn’t) verified

- **Install scripts** (`scripts/install-linux.sh`,
  `scripts/install-macos.sh`) verify the bundle’s **sha256 integrity
  only — not authorship**. A matching hash proves the download wasn’t
  corrupted or tampered with in transit; it does not prove who built it.
- **The launcher’s updater DOES verify authorship:** every release
  bundle carries an Ed25519 signature over
  `"<version>|<target>|<sha256>"` (see `UPDATE_SYSTEM.md`), checked
  against the public key compiled into the launcher. Unsigned or
  mis-signed bundles are refused.
- Releases are built by CI from `master`; review the workflow in
  `.github/workflows/release.yml` if you want to audit the chain.

## No telemetry

BunDeck sends **no telemetry, no analytics, no crash reports, no
phone-home**. The only network traffic is what you trigger: release/
manifest checks by the launcher updater, and relay traffic when
remote access is enabled. There is nothing to opt out of because
nothing is collected.
