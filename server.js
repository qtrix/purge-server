// ws-server/server.js - Complete Fixed Version
require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3001;
const HEARTBEAT_INTERVAL = 30000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['*'];

const games = new Map();
const playerConnections = new Map();

class GameRoom {
  constructor(gameId) {
    this.gameId = gameId;
    this.players = new Map();
    this.clients = new Set();
    this.createdAt = Date.now();
  }

  addPlayer(playerId, ws, initialState = null) {
    this.clients.add(ws);
    this.players.set(playerId, {
      id: playerId,
      ws,
      state: initialState,
      lastUpdate: Date.now(),
      alive: true
    });
    console.log(`✅ Player ${playerId.slice(0, 8)} joined game ${this.gameId} (${this.players.size} players)`);
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      this.clients.delete(player.ws);
      this.players.delete(playerId);
      console.log(`❌ Player ${playerId.slice(0, 8)} left game ${this.gameId} (${this.players.size} players)`);
    }
  }

  updatePlayerState(playerId, state) {
    const player = this.players.get(playerId);
    if (player) {
      player.state = state;
      player.lastUpdate = Date.now();
      player.alive = state.alive !== false;
    }
  }

  broadcast(message, excludePlayerId = null) {
    const data = JSON.stringify(message);
    let sentCount = 0;
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        if (!excludePlayerId || client.playerId !== excludePlayerId) {
          try {
            client.send(data);
            sentCount++;
          } catch (error) {
            console.error(`Failed to send to client:`, error.message);
          }
        }
      }
    });
    return sentCount;
  }

  getActivePlayers() {
    const players = [];
    this.players.forEach((player) => {
      if (player.state && player.alive) {
        players.push({ id: player.id, ...player.state });
      }
    });
    return players;
  }

  isEmpty() {
    return this.clients.size === 0;
  }
}

// Create HTTP server first
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'Solana Survivor WebSocket Server',
      games: games.size,
      players: 0, // Will be set below
      uptime: Math.floor(process.uptime()),
      timestamp: Date.now(),
      version: '1.0.0'
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Solana Survivor WebSocket Server\n\nConnect via WebSocket: wss://' + req.headers.host);
  }
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ 
  noServer: true,
  perMessageDeflate: false
});

console.log('🎮 ==========================================');
console.log('🎮 Solana Survivor WebSocket Server');
console.log('🎮 ==========================================');
console.log(`🚀 Starting server on port ${PORT}`);
console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
console.log('🎮 ==========================================\n');

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  
  // Check origin if needed
  if (process.env.NODE_ENV === 'production' && !ALLOWED_ORIGINS.includes('*')) {
    const allowed = ALLOWED_ORIGINS.some(allowed => origin?.includes(allowed));
    if (!allowed) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  const gameId = params.get('gameId');
  const playerId = params.get('playerId');

  if (!gameId || !playerId) {
    console.log('❌ Connection rejected: Missing gameId or playerId');
    ws.close(1008, 'Missing gameId or playerId');
    return;
  }

  ws.gameId = gameId;
  ws.playerId = playerId;
  ws.isAlive = true;
  ws.joinedAt = Date.now();

  if (!games.has(gameId)) {
    games.set(gameId, new GameRoom(gameId));
    console.log(`🎮 New game room created: ${gameId}`);
  }

  const gameRoom = games.get(gameId);
  gameRoom.addPlayer(playerId, ws);
  playerConnections.set(playerId, ws);

  const activePlayers = gameRoom.getActivePlayers();
  ws.send(JSON.stringify({
    type: 'sync',
    players: activePlayers,
    timestamp: Date.now()
  }));

  console.log(`📊 Game ${gameId}: ${gameRoom.players.size} players connected`);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleMessage(ws, gameRoom, message);
    } catch (error) {
      console.error('❌ Message parse error:', error.message);
    }
  });

  ws.on('close', (code) => {
    console.log(`🔌 Player ${playerId.slice(0, 8)} disconnected (code: ${code})`);
    gameRoom.removePlayer(playerId);
    playerConnections.delete(playerId);
    gameRoom.broadcast({
      type: 'player_disconnected',
      playerId: playerId,
      timestamp: Date.now()
    });
    if (gameRoom.isEmpty()) {
      games.delete(gameId);
      console.log(`🗑️  Game room ${gameId} deleted (empty)`);
    }
  });

  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for player ${playerId.slice(0, 8)}:`, error.message);
  });

  gameRoom.broadcast({
    type: 'player_connected',
    playerId: playerId,
    timestamp: Date.now()
  }, playerId);
});

function handleMessage(ws, gameRoom, message) {
  const { type, data } = message;

  switch (type) {
    case 'heartbeat':
      ws.isAlive = true;
      ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
      break;

    case 'update':
      if (data) {
        gameRoom.updatePlayerState(ws.playerId, data);
        gameRoom.broadcast({
          type: 'update',
          playerId: ws.playerId,
          data: data,
          timestamp: Date.now()
        }, ws.playerId);
      }
      break;

    case 'eliminated':
      gameRoom.updatePlayerState(ws.playerId, { ...gameRoom.players.get(ws.playerId)?.state, alive: false });
      console.log(`💀 Player ${ws.playerId.slice(0, 8)} eliminated in game ${ws.gameId}`);
      gameRoom.broadcast({
        type: 'eliminated',
        playerId: ws.playerId,
        timestamp: Date.now()
      });
      break;

    case 'winner':
      const winnerId = message.winnerId;
      console.log(`🏆 WINNER in game ${ws.gameId}: ${winnerId.slice(0, 8)}`);
      gameRoom.broadcast({
        type: 'winner',
        winnerId: winnerId,
        declaredBy: ws.playerId,
        timestamp: Date.now()
      });
      break;

    default:
      console.log(`⚠️  Unknown message type: ${type}`);
  }
}

// Heartbeat
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`💔 Terminating dead connection: ${ws.playerId?.slice(0, 8)}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// Stats
setInterval(() => {
  const totalGames = games.size;
  const totalPlayers = wss.clients.size;
  if (totalPlayers > 0) {
    console.log(`\n📊 STATS: ${totalGames} games, ${totalPlayers} players`);
  }
}, 60000);

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://0.0.0.0:${PORT}`);
  console.log(`📍 Health: http://0.0.0.0:${PORT}/health`);
  console.log(`📍 WebSocket: ws://0.0.0.0:${PORT}\n`);
});

// Shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received');
  server.close(() => {
    wss.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  server.close(() => {
    wss.close(() => {
      console.log('✅ Closed');
      process.exit(0);
    });
  });
});