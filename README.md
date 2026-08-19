# GetAClue

A self-hosted online whodunnit deduction game in the spirit of Clue, set in
Blackwood Manor with its own cast of suspects, weapons, and rooms. One Node.js
server, one HTML page, playable with 2–6 friends over a Cloudflare quick tunnel.

## Play online with a friend

```powershell
npm install          # first time only
.\play.ps1
```

`play.ps1` starts the game server and a `cloudflared` quick tunnel, and prints a
`https://....trycloudflare.com` link. Open it yourself, send it to your friend,
create a game, and give them the 4-letter code. (Needs
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):
`winget install Cloudflare.cloudflared`.)

To play on your LAN only, just run `npm start` and share
`http://<your-ip>:3477`. Set the `PORT` environment variable to change the port.

## How to play

One suspect, one weapon, and one room are sealed in the envelope. On your turn
you roll automatically, move up to 1–3 rooms (watch for the two secret passages
🚪), then **suggest** a suspect + weapon in your current room. Track what you
learn in the detective's notebook (auto-marks cards you've seen; click to add
your own ✗ and ? marks). Disconnected? Reopen the same link in the same browser
and you're back in your seat.

The host picks a mode in the lobby:

### 🤝 Co-op (best with 2)

You're all on the same side, racing the clock: the killer escapes at dawn, 16
turns away. Nobody holds cards — the manor does. Each suggestion makes the
manor publicly clear **one** innocent card among the three you named; if it
stays silent, every un-cleared card you named is in the envelope. Plan probes
together in the chat, then accuse — right, and you all win; wrong, and the
killer escapes for good. (Tune the difficulty via `DAWN_TURNS` in `server.js`.)

### 🎩 Classic (best with 3–6)

Traditional competitive deduction: the remaining cards are dealt out, the next
player holding one of your suggested cards privately shows you one, and the
named suspect gets dragged into the room. Accuse right to win; accuse wrong and
you're off the case (you still show cards). Last detective standing also wins.

## Tech

- `server.js` — authoritative game engine + static file server (Node 18+, only
  dependency is `ws`).
- `public/index.html` — the whole client: mansion map, hand, notebook, case
  log, and chat in one page.
- `public/img/` — room photos from Wikimedia Commons; see
  [`public/img/CREDITS.md`](public/img/CREDITS.md) for attribution.
