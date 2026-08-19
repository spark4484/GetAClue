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

- One suspect, one weapon, and one room are sealed in the envelope; the rest of
  the cards are dealt out. Leftovers are shown face-up to everyone.
- On your turn you roll automatically, move up to 1–3 rooms (watch for the two
  secret passages 🚪), then may **suggest** a suspect + weapon in your current
  room. The next player who holds one of those three cards must privately show
  you one. The named suspect gets dragged into the room.
- Track what you learn in the detective's notebook (auto-marks cards you've
  seen; click to add your own ✗ and ? marks).
- When you're sure, **accuse**. Right: you win. Wrong: you're off the case, but
  you still show cards. Last detective standing also wins.
- Disconnected? Reopen the same link in the same browser and you're back in
  your seat.

## Tech

- `server.js` — authoritative game engine + static file server (Node 18+, only
  dependency is `ws`).
- `public/index.html` — the whole client: mansion map, hand, notebook, case
  log, and chat in one page.
