const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const CARD_RANKS = ['4','5','6','7','8','9','10','B','D','K','A','2','3','JB','JR'];
const RANK_VALUE = {};
CARD_RANKS.forEach((r, i) => RANK_VALUE[r] = i);
const SUITS = ['♠','♥','♦','♣'];

function createDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of CARD_RANKS.slice(0,13))
      deck.push({ rank, suit, id: `${rank}${suit}` });
  deck.push({ rank:'JB', suit:'🃏', id:'JB' });
  deck.push({ rank:'JR', suit:'🃟', id:'JR' });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}

function getCombination(cards) {
  if (!cards || cards.length === 0) return null;
  const n = cards.length;
  const ranks = cards.map(c => c.rank);
  const vals = ranks.map(r => RANK_VALUE[r]);
  if (n === 1) return { type:'single', rank:ranks[0], value:vals[0] };
  const allSame = ranks.every(r => r === ranks[0]);
  if (allSame) {
    if (n === 2) return { type:'pair', rank:ranks[0], value:vals[0] };
    if (n === 3) return { type:'triple', rank:ranks[0], value:vals[0] };
    if (n === 4) return { type:'quad', rank:ranks[0], value:vals[0] };
  }
  if (n >= 4) {
    const validForKatarik = vals.every(v => v <= RANK_VALUE['A']);
    if (validForKatarik) {
      const sorted = [...vals].sort((a,b) => a-b);
      let ok = true;
      for (let i=1; i<sorted.length; i++) if (sorted[i] !== sorted[i-1]+1) { ok=false; break; }
      if (ok) return { type:'katarik', minVal:sorted[0], maxVal:sorted[sorted.length-1], length:n };
    }
  }
  if (n >= 6 && n%2 === 0) {
    const pairs = {};
    for (const r of ranks) pairs[r] = (pairs[r]||0)+1;
    const pairRanks = Object.entries(pairs).filter(([r,c]) => c===2).map(([r]) => r);
    if (pairRanks.length === n/2) {
      const pv = pairRanks.map(r => RANK_VALUE[r]).sort((a,b) => a-b);
      let ok = true;
      for (let i=1; i<pv.length; i++) if (pv[i] !== pv[i-1]+1) { ok=false; break; }
      if (ok) return { type:'sanzhud', minVal:pv[0], maxVal:pv[pv.length-1], length:pv.length };
    }
  }
  return null;
}

function canBeat(a, d) {
  if (!a || !d) return false;
  if (a.type === 'quad') return d.type === 'quad' ? a.value > d.value : true;
  if (a.type === 'triple') {
    if (d.type === 'quad') return false;
    if (d.type === 'triple') return a.value > d.value;
    return ['single','pair','katarik','sanzhud'].includes(d.type);
  }
  if (a.type === d.type) {
    if (a.type === 'single' || a.type === 'pair') return a.value > d.value;
    if (a.type === 'katarik' || a.type === 'sanzhud') return a.length === d.length && a.maxVal > d.maxVal;
  }
  return false;
}

const rooms = {};

function createRoom(id) {
  return { id, players:[], state:'lobby', currentPlayerIdx:0, tablePlay:null, lastWinnerId:null, finishOrder:[], gameCount:0, passCount:0, activePlayers:[] };
}

function broadcast(room, msg) {
  for (const p of room.players)
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}

function sendToPlayer(room, playerId, msg) {
  const p = room.players.find(x => x.id === playerId);
  if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}

function sendFullState(room) {
  const pub = {
    type:'state', state:room.state,
    players: room.players.map(p => ({ id:p.id, name:p.name, cardCount:p.hand?p.hand.length:0, connected:p.connected, finished:p.finished, finishRank:p.finishRank })),
    currentPlayerId: room.activePlayers[room.currentPlayerIdx]||null,
    tablePlay: room.tablePlay ? { playerId:room.tablePlay.playerId, cards:room.tablePlay.cards, combination:room.tablePlay.combination } : null,
    finishOrder:room.finishOrder, activePlayers:room.activePlayers, gameCount:room.gameCount
  };
  broadcast(room, pub);
  for (const p of room.players)
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ type:'hand', hand:p.hand||[] }));
}

function startGame(room) {
  room.state='playing'; room.gameCount++; room.finishOrder=[]; room.tablePlay=null; room.passCount=0;
  const deck = shuffle(createDeck());
  const n = room.players.length;
  const pp = Math.floor(54/n);
  room.activePlayers = room.players.map(p => p.id);
  let ci = 0;
  for (const p of room.players) { p.hand=deck.slice(ci,ci+pp); ci+=pp; p.finished=false; p.finishRank=null; }
  let ex = 54-pp*n, ei=0;
  while (ex-->0) room.players[ei++].hand.push(deck[ci++]);
  let si=0;
  if (room.gameCount===1) { for (let i=0;i<room.players.length;i++) if (room.players[i].hand.some(c=>c.rank==='4'&&c.suit==='♠')) { si=i; break; } }
  else if (room.lastWinnerId) { const ix=room.players.findIndex(p=>p.id===room.lastWinnerId); if(ix!==-1) si=ix; }
  room.currentPlayerIdx = room.activePlayers.indexOf(room.players[si].id);
  if (room.currentPlayerIdx===-1) room.currentPlayerIdx=0;
  broadcast(room, { type:'gameStarted', gameCount:room.gameCount });
  sendFullState(room);
}

function nextPlayer(room) {
  room.currentPlayerIdx = (room.currentPlayerIdx+1) % room.activePlayers.length;
}

function removePlayer(room, playerId) {
  room.finishOrder.push(playerId);
  const p = room.players.find(x=>x.id===playerId);
  if (p) { p.finished=true; p.finishRank=room.finishOrder.length; }
  const idx = room.activePlayers.indexOf(playerId);
  if (idx!==-1) { room.activePlayers.splice(idx,1); if(room.currentPlayerIdx>=room.activePlayers.length) room.currentPlayerIdx=0; }
  if (room.activePlayers.length===1) {
    const lid=room.activePlayers[0];
    const lp=room.players.find(p=>p.id===lid);
    room.finishOrder.push(lid);
    if(lp){lp.finished=true;lp.finishRank=room.finishOrder.length;}
    room.activePlayers=[];
    room.lastWinnerId=room.finishOrder[0];
    room.state='ended';
    broadcast(room,{type:'gameOver',finishOrder:room.finishOrder,players:room.players.map(p=>({id:p.id,name:p.name,finishRank:p.finishRank}))});
    return true;
  }
  return false;
}

function handlePlay(room, playerId, cardIds) {
  if (room.activePlayers[room.currentPlayerIdx]!==playerId) { sendToPlayer(room,playerId,{type:'error',msg:'Не ваш ход'}); return; }
  const player=room.players.find(p=>p.id===playerId);
  if (!player) return;
  const played=cardIds.map(id=>player.hand.find(c=>c.id===id)).filter(Boolean);
  if (played.length!==cardIds.length) { sendToPlayer(room,playerId,{type:'error',msg:'Карты не найдены'}); return; }
  const combo=getCombination(played);
  if (!combo) { sendToPlayer(room,playerId,{type:'error',msg:'Недопустимая комбинация'}); return; }
  if (room.tablePlay && !canBeat(combo,room.tablePlay.combination)) { sendToPlayer(room,playerId,{type:'error',msg:'Комбинация слабее'}); return; }
  for (const c of played) { const i=player.hand.findIndex(x=>x.id===c.id); if(i!==-1) player.hand.splice(i,1); }
  room.tablePlay={playerId,cards:played,combination:combo};
  room.passCount=0;
  broadcast(room,{type:'played',playerId,playerName:player.name,cards:played,combination:combo});
  if (player.hand.length===0) {
    broadcast(room,{type:'playerFinished',playerId,playerName:player.name});
    if (removePlayer(room,playerId)) return;
    room.tablePlay=null; room.passCount=0;
    sendFullState(room); return;
  }
  nextPlayer(room); sendFullState(room);
}

function handlePass(room, playerId) {
  if (room.activePlayers[room.currentPlayerIdx]!==playerId) { sendToPlayer(room,playerId,{type:'error',msg:'Не ваш ход'}); return; }
  if (!room.tablePlay) { sendToPlayer(room,playerId,{type:'error',msg:'Нельзя пасовать'}); return; }
  const player=room.players.find(p=>p.id===playerId);
  room.passCount++;
  broadcast(room,{type:'passed',playerId,playerName:player.name});
  if (room.passCount>=room.activePlayers.length-1) {
    const wid=room.tablePlay.playerId;
    const wp=room.players.find(p=>p.id===wid);
    room.tablePlay=null; room.passCount=0;
    broadcast(room,{type:'roundWon',playerId:wid,playerName:wp?wp.name:''});
    const wi=room.activePlayers.indexOf(wid);
    room.currentPlayerIdx = wi!==-1 ? wi : (room.currentPlayerIdx%room.activePlayers.length);
    sendFullState(room); return;
  }
  nextPlayer(room); sendFullState(room);
}

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname,'index.html'), (err,data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let playerId=null, roomId=null;
  ws.on('message', (raw) => {
    let msg; try { msg=JSON.parse(raw); } catch { return; }
    if (msg.type==='join') {
      roomId=msg.roomId||'default';
      const name=(msg.name||'Игрок').slice(0,20);
      playerId=msg.playerId||`p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      if (!rooms[roomId]) rooms[roomId]=createRoom(roomId);
      const room=rooms[roomId];
      const ex=room.players.find(p=>p.id===playerId);
      if (ex) { ex.ws=ws; ex.connected=true; ws.send(JSON.stringify({type:'joined',playerId,roomId,yourName:ex.name})); sendFullState(room); if(ex.hand) ws.send(JSON.stringify({type:'hand',hand:ex.hand})); return; }
      if (room.state!=='lobby') { ws.send(JSON.stringify({type:'error',msg:'Игра уже идёт'})); return; }
      if (room.players.length>=9) { ws.send(JSON.stringify({type:'error',msg:'Комната полна'})); return; }
      room.players.push({id:playerId,name,ws,connected:true,hand:[],finished:false,finishRank:null});
      ws.send(JSON.stringify({type:'joined',playerId,roomId,yourName:name}));
      broadcast(room,{type:'playerJoined',playerName:name,playerCount:room.players.length});
      sendFullState(room); return;
    }
    const room=rooms[roomId]; if(!room) return;
    if (msg.type==='startGame') {
      if (room.state!=='lobby'&&room.state!=='ended') return;
      if (room.players.length<3) { sendToPlayer(room,playerId,{type:'error',msg:'Нужно минимум 3 игрока'}); return; }
      if (room.state==='ended') room.state='lobby';
      startGame(room); return;
    }
    if (msg.type==='play' && room.state==='playing') { handlePlay(room,playerId,msg.cardIds); return; }
    if (msg.type==='pass' && room.state==='playing') { handlePass(room,playerId); return; }
    if (msg.type==='chat') {
      const p=room.players.find(x=>x.id===playerId);
      if(p) broadcast(room,{type:'chat',playerName:p.name,text:(msg.text||'').slice(0,200)});
    }
  });
  ws.on('close', () => {
    if(!roomId||!rooms[roomId]) return;
    const room=rooms[roomId];
    const p=room.players.find(x=>x.id===playerId);
    if(p){p.connected=false;broadcast(room,{type:'playerDisconnected',playerName:p.name});sendFullState(room);}
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Katarik running on port ${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
