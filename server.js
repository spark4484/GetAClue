// GetAClue — self-hosted whodunnit deduction game server.
// Plain Node http server for static files + ws for the game protocol.
// The server is authoritative: hands, the envelope, and turn flow all live here.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3477;

// ---------------------------------------------------------------------------
// Game data (original theme — Blackwood Manor)
// ---------------------------------------------------------------------------

const SUSPECTS = [
  'Madame Sapphire',
  'Colonel Custard',
  'Professor Pewter',
  'Miss Vermilion',
  'Doctor Damson',
  'Captain Celadon',
];

const WEAPONS = [
  'Antique Revolver',
  'Poisoned Sherry',
  'Letter Opener',
  'Cast-Iron Skillet',
  'Silk Scarf',
  'Marble Bust',
];

// 3x3 mansion grid, row-major. Index = row*3 + col.
const ROOMS = [
  'Study', 'Library', 'Greenhouse',
  'Music Room', 'Grand Hall', 'Trophy Room',
  'Kitchen', 'Ballroom', 'Wine Cellar',
];

// Orthogonal adjacency plus two diagonal secret passages.
const PASSAGES = [
  ['Study', 'Wine Cellar'],
  ['Greenhouse', 'Kitchen'],
];

const ADJACENCY = (() => {
  const adj = {};
  ROOMS.forEach((r) => (adj[r] = new Set()));
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const here = ROOMS[row * 3 + col];
      if (col < 2) { adj[here].add(ROOMS[row * 3 + col + 1]); adj[ROOMS[row * 3 + col + 1]].add(here); }
      if (row < 2) { adj[here].add(ROOMS[(row + 1) * 3 + col]); adj[ROOMS[(row + 1) * 3 + col]].add(here); }
    }
  }
  for (const [a, b] of PASSAGES) { adj[a].add(b); adj[b].add(a); }
  return adj;
})();

function reachableRooms(from, steps) {
  const dist = { [from]: 0 };
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of ADJACENCY[cur]) {
      if (!(next in dist)) {
        dist[next] = dist[cur] + 1;
        queue.push(next);
      }
    }
  }
  return ROOMS.filter((r) => r !== from && dist[r] <= steps);
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

const games = new Map(); // code -> game

function makeCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (games.has(code));
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newGame(hostName) {
  const game = {
    code: makeCode(),
    phase: 'lobby', // lobby | move | suggest | refute | end | over
    players: [], // { token, name, character, hand, room, active, ws }
    hostToken: null,
    envelope: null, // { suspect, weapon, room }
    faceUp: [], // leftover cards shown to everyone
    turnIndex: 0,
    roll: 0,
    steps: 0,
    reachable: [],
    suggestedThisTurn: false,
    pendingSuggestion: null, // { bySeat, suspect, weapon, room, refuterSeat, matches }
    winnerSeat: null,
    log: [],
  };
  games.set(game.code, game);
  addPlayer(game, hostName);
  game.hostToken = game.players[0].token;
  return game;
}

function addPlayer(game, name) {
  const player = {
    token: crypto.randomBytes(12).toString('hex'),
    name: String(name || 'Detective').slice(0, 20) || 'Detective',
    character: null,
    hand: [],
    room: null,
    active: true,
    ws: null,
  };
  game.players.push(player);
  return player;
}

function logEvent(game, text) {
  game.log.push(text);
  if (game.log.length > 200) game.log.shift();
}

function startGame(game) {
  const characters = shuffle(SUSPECTS);
  const startRooms = shuffle(ROOMS);
  game.players.forEach((p, i) => {
    p.character = characters[i];
    p.room = startRooms[i % startRooms.length];
    p.hand = [];
    p.active = true;
  });

  game.envelope = {
    suspect: SUSPECTS[crypto.randomInt(SUSPECTS.length)],
    weapon: WEAPONS[crypto.randomInt(WEAPONS.length)],
    room: ROOMS[crypto.randomInt(ROOMS.length)],
  };

  const deck = shuffle(
    [...SUSPECTS, ...WEAPONS, ...ROOMS].filter(
      (c) => c !== game.envelope.suspect && c !== game.envelope.weapon && c !== game.envelope.room
    )
  );
  const perPlayer = Math.floor(deck.length / game.players.length);
  game.players.forEach((p, i) => {
    p.hand = deck.slice(i * perPlayer, (i + 1) * perPlayer).sort();
  });
  game.faceUp = deck.slice(perPlayer * game.players.length).sort();

  game.turnIndex = crypto.randomInt(game.players.length);
  game.winnerSeat = null;
  game.log = [];
  logEvent(game, `The body of the manor's owner has been found. ${game.players.length} detectives are on the case.`);
  if (game.faceUp.length) {
    logEvent(game, `Face-up cards for everyone: ${game.faceUp.join(', ')}.`);
  }
  beginTurn(game);
}

function beginTurn(game) {
  const player = game.players[game.turnIndex];
  game.roll = crypto.randomInt(6) + 1;
  // 1-2 -> 1 room, 3-4 -> 2 rooms, 5-6 -> 3 rooms of movement.
  game.steps = Math.ceil(game.roll / 2);
  game.reachable = reachableRooms(player.room, game.steps);
  game.suggestedThisTurn = false;
  game.pendingSuggestion = null;
  game.phase = 'move';
  logEvent(game, `${player.name}'s turn. They rolled a ${game.roll} (move up to ${game.steps} room${game.steps > 1 ? 's' : ''}).`);
}

function advanceTurn(game) {
  const activeSeats = game.players.filter((p) => p.active).length;
  if (activeSeats === 0) {
    endGame(game, null, `Every detective accused the wrong person — the killer walks free`);
    return;
  }
  if (activeSeats === 1 && game.players.length > 1) {
    const lastSeat = game.players.findIndex((p) => p.active);
    endGame(game, lastSeat, `${game.players[lastSeat].name} is the last detective standing`);
    return;
  }
  do {
    game.turnIndex = (game.turnIndex + 1) % game.players.length;
  } while (!game.players[game.turnIndex].active);
  beginTurn(game);
}

function endGame(game, winnerSeat, reason) {
  game.phase = 'over';
  game.winnerSeat = winnerSeat;
  const { suspect, weapon, room } = game.envelope;
  logEvent(game, `${reason}. The truth: ${suspect} did it with the ${weapon} in the ${room}.`);
}

// ---------------------------------------------------------------------------
// Personalized state serialization
// ---------------------------------------------------------------------------

function stateFor(game, player) {
  const seat = game.players.indexOf(player);
  const current = game.players[game.turnIndex];
  const suggestion = game.pendingSuggestion;
  return {
    type: 'state',
    code: game.code,
    phase: game.phase,
    suspects: SUSPECTS,
    weapons: WEAPONS,
    rooms: ROOMS,
    passages: PASSAGES,
    you: seat,
    isHost: player.token === game.hostToken,
    players: game.players.map((p) => ({
      name: p.name,
      character: p.character,
      room: p.room,
      active: p.active,
      connected: !!p.ws,
      cardCount: p.hand.length,
    })),
    yourHand: player.hand,
    faceUp: game.faceUp,
    turn: game.turnIndex,
    roll: game.roll,
    steps: game.steps,
    reachable: game.phase === 'move' && seat === game.turnIndex ? game.reachable : [],
    suggestedThisTurn: game.suggestedThisTurn,
    suggestion: suggestion
      ? {
          by: suggestion.bySeat,
          suspect: suggestion.suspect,
          weapon: suggestion.weapon,
          room: suggestion.room,
          refuter: suggestion.refuterSeat,
          // Only the refuter learns which of their cards match.
          matches: seat === suggestion.refuterSeat ? suggestion.matches : [],
        }
      : null,
    winner: game.winnerSeat,
    envelope: game.phase === 'over' ? game.envelope : null,
    log: game.log.slice(-60),
    turnName: current ? current.name : null,
  };
}

function broadcast(game) {
  for (const p of game.players) {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify(stateFor(game, p)));
    }
  }
}

function sendError(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', msg }));
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function resolveRefutation(game) {
  // Find the next player clockwise from the suggester who can refute.
  const s = game.pendingSuggestion;
  const cards = [s.suspect, s.weapon, s.room];
  for (let i = 1; i < game.players.length; i++) {
    const seat = (s.bySeat + i) % game.players.length;
    const p = game.players[seat];
    const matches = p.hand.filter((c) => cards.includes(c));
    if (matches.length) {
      s.refuterSeat = seat;
      s.matches = matches;
      game.phase = 'refute';
      logEvent(game, `${p.name} can refute the suggestion...`);
      // A disconnected refuter would stall the game — show a random match for them.
      if (!p.ws) {
        showCard(game, p, matches[crypto.randomInt(matches.length)]);
      }
      return;
    }
  }
  logEvent(game, `No one could refute the suggestion. Interesting...`);
  game.pendingSuggestion = null;
  game.phase = 'end';
}

function showCard(game, refuter, card) {
  const s = game.pendingSuggestion;
  const suggester = game.players[s.bySeat];
  logEvent(game, `${refuter.name} privately showed ${suggester.name} a card.`);
  if (suggester.ws && suggester.ws.readyState === 1) {
    suggester.ws.send(JSON.stringify({ type: 'reveal', card, from: refuter.name }));
  }
  game.pendingSuggestion = null;
  game.phase = 'end';
}

function handleMessage(ws, msg) {
  const { type } = msg;

  if (type === 'create') {
    const game = newGame(msg.name);
    const player = game.players[0];
    player.ws = ws;
    ws.gameCode = game.code;
    ws.playerToken = player.token;
    ws.send(JSON.stringify({ type: 'joined', code: game.code, token: player.token }));
    broadcast(game);
    return;
  }

  if (type === 'join') {
    const game = games.get(String(msg.code || '').toUpperCase().trim());
    if (!game) return sendError(ws, 'No game with that code.');
    if (game.phase !== 'lobby') return sendError(ws, 'That game has already started.');
    if (game.players.length >= 6) return sendError(ws, 'That game is full (6 players max).');
    const player = addPlayer(game, msg.name);
    player.ws = ws;
    ws.gameCode = game.code;
    ws.playerToken = player.token;
    ws.send(JSON.stringify({ type: 'joined', code: game.code, token: player.token }));
    logEvent(game, `${player.name} joined the investigation.`);
    broadcast(game);
    return;
  }

  if (type === 'rejoin') {
    const game = games.get(String(msg.code || '').toUpperCase().trim());
    if (!game) return sendError(ws, 'That game no longer exists.');
    const player = game.players.find((p) => p.token === msg.token);
    if (!player) return sendError(ws, 'Could not find your seat in that game.');
    if (player.ws && player.ws !== ws && player.ws.readyState === 1) player.ws.close();
    player.ws = ws;
    ws.gameCode = game.code;
    ws.playerToken = player.token;
    ws.send(JSON.stringify({ type: 'joined', code: game.code, token: player.token }));
    broadcast(game);
    return;
  }

  // Everything below requires being seated in a game.
  const game = games.get(ws.gameCode);
  if (!game) return sendError(ws, 'You are not in a game.');
  const player = game.players.find((p) => p.token === ws.playerToken);
  if (!player) return sendError(ws, 'You are not in this game.');
  const seat = game.players.indexOf(player);

  if (type === 'chat') {
    const text = String(msg.text || '').slice(0, 300).trim();
    if (text) {
      logEvent(game, `💬 ${player.name}: ${text}`);
      broadcast(game);
    }
    return;
  }

  if (type === 'start' || type === 'again') {
    if (player.token !== game.hostToken) return sendError(ws, 'Only the host can start the game.');
    if (type === 'start' && game.phase !== 'lobby') return sendError(ws, 'Game already started.');
    if (type === 'again' && game.phase !== 'over') return sendError(ws, 'The current case is still open.');
    if (game.players.length < 2) return sendError(ws, 'You need at least 2 players.');
    startGame(game);
    broadcast(game);
    return;
  }

  if (type === 'showCard') {
    const s = game.pendingSuggestion;
    if (game.phase !== 'refute' || !s || s.refuterSeat !== seat) return sendError(ws, 'Not your card to show.');
    if (!s.matches.includes(msg.card)) return sendError(ws, 'You must show a card that matches the suggestion.');
    showCard(game, player, msg.card);
    broadcast(game);
    return;
  }

  // Remaining actions belong to the player whose turn it is.
  if (seat !== game.turnIndex || game.phase === 'lobby' || game.phase === 'over') {
    return sendError(ws, 'It is not your turn.');
  }
  if (!player.active) return sendError(ws, 'You have been eliminated.');

  if (type === 'move') {
    if (game.phase !== 'move') return sendError(ws, 'You cannot move right now.');
    if (msg.room !== player.room && !game.reachable.includes(msg.room)) {
      return sendError(ws, 'You cannot reach that room this turn.');
    }
    if (msg.room !== player.room) {
      player.room = msg.room;
      logEvent(game, `${player.name} moved to the ${msg.room}.`);
    } else {
      logEvent(game, `${player.name} stayed in the ${player.room}.`);
    }
    game.phase = 'suggest';
    broadcast(game);
    return;
  }

  if (type === 'suggest') {
    if (game.phase !== 'suggest') return sendError(ws, 'You cannot make a suggestion right now.');
    if (!SUSPECTS.includes(msg.suspect) || !WEAPONS.includes(msg.weapon)) {
      return sendError(ws, 'Invalid suggestion.');
    }
    game.suggestedThisTurn = true;
    game.pendingSuggestion = {
      bySeat: seat,
      suspect: msg.suspect,
      weapon: msg.weapon,
      room: player.room,
      refuterSeat: null,
      matches: [],
    };
    logEvent(game, `${player.name} suggests: ${msg.suspect}, with the ${msg.weapon}, in the ${player.room}.`);
    // The named suspect is dragged into the room, as tradition demands.
    const dragged = game.players.find((p) => p.character === msg.suspect);
    if (dragged && dragged.room !== player.room) {
      dragged.room = player.room;
      logEvent(game, `${dragged.name} (${msg.suspect}) was pulled into the ${player.room}.`);
    }
    resolveRefutation(game);
    broadcast(game);
    return;
  }

  if (type === 'skipSuggest') {
    if (game.phase !== 'suggest') return sendError(ws, 'Nothing to skip.');
    game.phase = 'end';
    broadcast(game);
    return;
  }

  if (type === 'accuse') {
    if (!['move', 'suggest', 'end'].includes(game.phase)) {
      return sendError(ws, 'You cannot accuse right now.');
    }
    if (!SUSPECTS.includes(msg.suspect) || !WEAPONS.includes(msg.weapon) || !ROOMS.includes(msg.room)) {
      return sendError(ws, 'Invalid accusation.');
    }
    logEvent(game, `⚖️ ${player.name} ACCUSES: ${msg.suspect}, with the ${msg.weapon}, in the ${msg.room}!`);
    const e = game.envelope;
    if (msg.suspect === e.suspect && msg.weapon === e.weapon && msg.room === e.room) {
      endGame(game, seat, `${player.name} cracked the case`);
    } else {
      player.active = false;
      logEvent(game, `${player.name} accused the wrong person and is off the case. They will still refute suggestions.`);
      advanceTurn(game);
    }
    broadcast(game);
    return;
  }

  if (type === 'endTurn') {
    if (game.phase !== 'end' && game.phase !== 'suggest' && game.phase !== 'move') {
      return sendError(ws, 'You cannot end your turn right now.');
    }
    advanceTurn(game);
    broadcast(game);
    return;
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket plumbing
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(__dirname, 'public', rel);
  if (!file.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('handler error:', err);
      sendError(ws, 'Something went wrong on the server.');
    }
  });

  ws.on('close', () => {
    const game = games.get(ws.gameCode);
    if (!game) return;
    const player = game.players.find((p) => p.token === ws.playerToken);
    if (player && player.ws === ws) {
      player.ws = null;
      // In the lobby, a departing player simply leaves their seat.
      if (game.phase === 'lobby') {
        game.players.splice(game.players.indexOf(player), 1);
        if (!game.players.length) {
          games.delete(game.code);
          return;
        }
        if (game.hostToken === player.token) game.hostToken = game.players[0].token;
        logEvent(game, `${player.name} left the investigation.`);
      } else {
        logEvent(game, `${player.name} disconnected. They can rejoin from the same browser.`);
        // Don't let a mid-refutation disconnect stall the game.
        const s = game.pendingSuggestion;
        if (game.phase === 'refute' && s && game.players[s.refuterSeat] === player) {
          showCard(game, player, s.matches[crypto.randomInt(s.matches.length)]);
        }
        if (game.players.every((p) => !p.ws)) {
          // Everyone is gone — keep the game for an hour, then clean up.
          setTimeout(() => {
            const g = games.get(game.code);
            if (g && g.players.every((p) => !p.ws)) games.delete(game.code);
          }, 60 * 60 * 1000).unref();
        }
      }
      broadcast(game);
    }
  });
});

server.listen(PORT, () => {
  console.log(`GetAClue is running at http://localhost:${PORT}`);
  console.log(`Share it with: cloudflared tunnel --url http://localhost:${PORT}`);
});
