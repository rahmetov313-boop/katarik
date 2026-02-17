const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ─── Card definitions ────────────────────────────────────────────────────────
const CARD_RANKS = ['4','5','6','7','8','9','10','B','D','K','A','2','3','JB','JR'];
const RANK_VALUE = {};
CARD_RANKS.forEach((r, i) => RANK_VALUE[r] = i);

const SUITS = ['♠','♥','♦','♣'];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of CARD_RANKS.slice(0, 13)) {
      deck.push({ rank, suit, id: `${rank}${suit}` });
    }
  }
  deck.push({ rank: 'JB', suit: '🃏', id: 'JB' });
  deck.push({ rank: 'JR', suit: '🃟', id: 'JR' });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getCombination(cards) {
  if (!cards || cards.length === 0) return null;
  const n = cards.length;
  const ranks = cards.map(c => c.rank);
  const vals = ranks.map(r => RANK_VALUE[r]);

  if (n === 1) return { type: 'single', rank: ranks[0], value: vals[0] };

  const allSame = ranks.every(r => r === ranks[0]);
  if (allSame) {
    if (n === 2) return { type: 'pair', rank: ranks[0], value: vals[0] };
    if (n === 3) return { type: 'triple', rank: ranks[0], value: vals[0] };
    if (n === 4) return { type: 'quad', rank: ranks[0], value: vals[0] };
  }

  if (n >= 4) {
    const validForKatarik = vals.every(v => v <= RANK_VALUE['A']);
    if (validForKatarik) {
      const sorted = [...vals].sort((a, b) => a - b);
      let consecutive = true;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== sorted[i-1] + 1) { consecutive = false; break; }
      }
      if (consecutive) return { type: 'katarik', minVal: sorted[0], maxVal: sorted[sorted.length-1], length: n };
    }
  }

  if (n >= 6 && n % 2 === 0) {
    const pairs = {};
    for (const r of ranks) pairs[r] = (pairs[r] || 0) + 1;
    const pairRanks = Object.entries(pairs).filter(([r, c]) => c === 2).map(([r]) => r);
    if (pairRanks.length === n / 2) {
      const pairVals = pairRanks.map(r => RANK_VALUE[r]).sort((a, b) => a - b);
      let consecutive = true;
      for (let i = 1; i < pairVals.length; i++) {
        if (pairVals[i] !== pairVals[i-1] + 1) { consecutive = false; break; }
      }
      if (consecutive) return { type: 'sanzhud', minVal: pairVals[0], maxVal: pairVals[pairVals.length-1], length: pairVals.length };
    }
  }

  return null;
}

function canBeat(attacker, defender) {
  if (!attacker || !defender) return false;
  const at = attacker.type;
  const dt = defender.type;

  if (at === 'quad') {
    if (dt === 'quad') return attacker.value > defender.value;
    return true;
  }

  if (at === 'triple') {
    if (dt === 'quad') return false;
    if (dt === 'triple') return attacker.value > defender.value;
    if (['single','pair','katarik','sanzhud'].includes(dt)) return true;
    return false;
  }

  if (at === dt) {
    if (at === 'single') return attacker.value > defender.value;
    if (at === 'pair') return attacker.value > defender.value;
    if (at === 'katarik') {
      if (attacker.length !== defender.length) return false;
      return attacker.maxVal > defender.maxVal;
    }
    if (at === 'sanzhud') {
      if (attacker.length !== defender.length) return false;
      return attacker.maxVal > defender.maxVal;
    }
  }

  return false;
}

const rooms = {};

function createRoom(roomId) {
  return {
    id: roomId,
    players: [],
    state: 'lobby',
    currentPlayerIdx: 0,
    tablePlay: null,
    lastWinnerId: null,
    finishOrder: [],
    gameCount: 0,
    passCount: 0,
    activePlayers: [],
  };
}

function broadcast(room, msg) {
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }
}

function sendToPlayer(room, playerId, msg) {
  const p = room.players.find(x => x.id === playerId);
  if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}

function getPublicState(room) {
  return {
    type: 'state',
    state: room.state,
    players: room.players.map(p => ({
      id: p.id, name: p.name,
      cardCount: p.hand ? p.hand.length : 0,
      connected: p.connected, finished: p.finished, finishRank: p.finishRank,
    })),
    currentPlayerId: room.activePlayers[room.currentPlayerIdx] || null,
    tablePlay: room.tablePlay ? {
      playerId: room.tablePlay.playerId,
      cards: room.tablePlay.cards,
      combination: room.tablePlay.combination,
    } : null,
    finishOrder: room.finishOrder,
    activePlayers: room.activePlayers,
    gameCount: room.gameCount,
  };
}

function sendFullState(room) {
  broadcast(room, getPublicState(room));
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1)
      p.ws.send(JSON.stringify({ type: 'hand', hand: p.hand || [] }));
  }
}

function startGame(room) {
  room.state = 'playing';
  room.gameCount++;
  room.finishOrder = [];
  room.tablePlay = null;
  room.passCount = 0;

  const deck = shuffle(createDeck());
  const n = room.players.length;
  const perPlayer = Math.floor(54 / n);

  room.activePlayers = room.players.map(p => p.id);
  let cardIdx = 0;
  for (const p of room.players) {
    p.hand = deck.slice(cardIdx, cardIdx + perPlayer);
    cardIdx += perPlayer;
    p.finished = false;
    p.finishRank = null;
  }
  let extra = 54 - perPlayer * n;
  let ei = 0;
  while (extra > 0) { room.players[ei].hand.push(deck[cardIdx++]); extra--; ei++; }

  let startIdx = 0;
  if (room.gameCount === 1) {
    for (let i = 0; i < room.players.length; i++) {
      if (room.players[i].hand.some(c => c.rank === '4' && c.suit === '♠')) { startIdx = i; break; }
    }
  } else if (room.lastWinnerId) {
    const idx = room.players.findIndex(p => p.id === room.lastWinnerId);
    if (idx !== -1) startIdx = idx;
  }

  room.currentPlayerIdx = room.activePlayers.indexOf(room.players[startIdx].id);
  if (room.currentPlayerIdx === -1) room.currentPlayerIdx = 0;

  broadcast(room, { type: 'gameStarted', gameCount: room.gameCount });
  sendFullState(room);
}

function nextActivePlayer(room) {
  room.currentPlayerIdx = (room.currentPlayerIdx + 1) % room.activePlayers.length;
}

function removeFinishedPlayer(room, playerId) {
  const rank = room.finishOrder.length + 1;
  room.finishOrder.push(playerId);
  const p = room.players.find(x => x.id === playerId);
  if (p) { p.finished = true; p.finishRank = rank; }

  const idx = room.activePlayers.indexOf(playerId);
  if (idx !== -1) {
    room.activePlayers.splice(idx, 1);
    if (room.currentPlayerIdx >= room.activePlayers.length) room.currentPlayerIdx = 0;
  }

  if (room.activePlayers.length === 1) {
    const loserId = room.activePlayers[0];
    const loser = room.players.find(p => p.id === loserId);
    room.finishOrder.push(loserId);
    if (loser) { loser.finished = true; loser.finishRank = room.finishOrder.length; }
    room.activePlayers = [];
    room.lastWinnerId = room.finishOrder[0];
    room.state = 'ended';
    broadcast(room, { type: 'gameOver', finishOrder: room.finishOrder, players: room.players.map(p => ({ id: p.id, name: p.name, finishRank: p.finishRank })) });
    return true;
  }
  return false;
}

function handlePlay(room, playerId, cardIds) {
  const currentId = room.activePlayers[room.currentPlayerIdx];
  if (currentId !== playerId) { sendToPlayer(room, playerId, { type: 'error', msg: 'Не ваш ход' }); return; }

  const player = room.players.find(p => p.id === playerId);
  if (!player) return;

  const playedCards = cardIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean);
  if (playedCards.length !== cardIds.length) { sendToPlayer(room, playerId, { type: 'error', msg: 'Карты не найдены' }); return; }

  const combo = getCombination(playedCards);
  if (!combo) { sendToPlayer(room, playerId, { type: 'error', msg: 'Недопустимая комбинация' }); return; }

  if (room.tablePlay && !canBeat(combo, room.tablePlay.combination)) {
    sendToPlayer(room, playerId, { type: 'error', msg: 'Эта комбинация не бьёт текущую' }); return;
  }

  for (const c of playedCards) {
    const idx = player.hand.findIndex(x => x.id === c.id);
    if (idx !== -1) player.hand.splice(idx, 1);
  }

  room.tablePlay = { playerId, cards: playedCards, combination: combo };
  room.passCount = 0;
  broadcast(room, { type: 'played', playerId, playerName: player.name, cards: playedCards, combination: combo });

  if (player.hand.length === 0) {
    broadcast(room, { type: 'playerFinished', playerId, playerName: player.name });
    const gameOver = removeFinishedPlayer(room, playerId);
    if (gameOver) return;
    room.tablePlay = null;
    room.passCount = 0;
    sendFullState(room);
    return;
  }

  nextActivePlayer(room);
  sendFullState(room);
}

function handlePass(room, playerId) {
  const currentId = room.activePlayers[room.currentPlayerIdx];
  if (currentId !== playerId) { sendToPlayer(room, playerId, { type: 'error', msg: 'Не ваш ход' }); return; }
  if (!room.tablePlay) { sendToPlayer(room, playerId, { type: 'error', msg: 'Нельзя пасовать — нужно ходить' }); return; }

  const player = room.players.find(p => p.id === playerId);
  room.passCount++;
  broadcast(room, { type: 'passed', playerId, playerName: player.name });

  const otherActive = room.activePlayers.length - 1;
  if (room.passCount >= otherActive) {
    const winnerId = room.tablePlay.playerId;
    const winner = room.players.find(p => p.id === winnerId);
    room.tablePlay = null;
    room.passCount = 0;
    broadcast(room, { type: 'roundWon', playerId: winnerId, playerName: winner ? winner.name : '' });
    const winnerIdx = room.activePlayers.indexOf(winnerId);
    if (winnerIdx !== -1) room.currentPlayerIdx = winnerIdx;
    else nextActivePlayer(room);
    sendFullState(room);
    return;
  }

  nextActivePlayer(room);
  sendFullState(room);
}

const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let playerId = null;
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      roomId = msg.roomId || 'default';
      const playerName = (msg.name || 'Игрок').slice(0, 20);
      playerId = msg.playerId || `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
      const room = rooms[roomId];

      const existing = room.players.find(p => p.id === playerId);
      if (existing) {
        existing.ws = ws;
        existing.connected = true;
        ws.send(JSON.stringify({ type: 'joined', playerId, roomId, yourName: existing.name }));
        sendFullState(room);
        if (existing.hand) ws.send(JSON.stringify({ type: 'hand', hand: existing.hand }));
        return;
      }

      if (room.state !== 'lobby') { ws.send(JSON.stringify({ type: 'error', msg: 'Игра уже идёт' })); return; }
      if (room.players.length >= 9) { ws.send(JSON.stringify({ type: 'error', msg: 'Комната полна' })); return; }

      room.players.push({ id: playerId, name: playerName, ws, connected: true, hand: [], finished: false, finishRank: null });
      ws.send(JSON.stringify({ type: 'joined', playerId, roomId, yourName: playerName }));
      broadcast(room, { type: 'playerJoined', playerName, playerCount: room.players.length });
      sendFullState(room);
      return;
    }

    const room = rooms[roomId];
    if (!room) return;

    if (msg.type === 'startGame') {
      if (room.state !== 'lobby' && room.state !== 'ended') return;
      if (room.players.length < 3) { sendToPlayer(room, playerId, { type: 'error', msg: 'Нужно минимум 3 игрока' }); return; }
      if (room.state === 'ended') room.state = 'lobby';
      startGame(room);
      return;
    }

    if (msg.type === 'play') { if (room.state === 'playing') handlePlay(room, playerId, msg.cardIds); return; }
    if (msg.type === 'pass') { if (room.state === 'playing') handlePass(room, playerId); return; }

    if (msg.type === 'chat') {
      const player = room.players.find(p => p.id === playerId);
      if (!player) return;
      broadcast(room, { type: 'chat', playerName: player.name, text: (msg.text || '').slice(0, 200) });
    }
  });

  ws.on('close', () => {
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const p = room.players.find(x => x.id === playerId);
    if (p) { p.connected = false; broadcast(room, { type: 'playerDisconnected', playerName: p.name }); sendFullState(room); }
  });
});

server.listen(PORT, () => console.log(`Katarik server running on port ${PORT}`));
