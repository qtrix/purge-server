// server.ts - Complete WebSocket Server pentru Purge Multiplayer
// Deploy on Railway with this implementation

import WebSocket from 'ws';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { parse } from 'url';

const app = express();
const server = createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ============================================
// TYPES
// ============================================

interface PlayerState {
  id: string;
  x: number;
  y: number;
  size: number;
  score: number;
  color?: string;
  ready?: boolean;
  eliminated?: boolean;
  timestamp?: number;
}

interface ClientConnection {
  ws: WebSocket;
  playerId: string;
  gameId: string;
  lastUpdate: number;
  isAlive: boolean;
}

type GamePhase = 'waiting' | 'countdown' | 'active' | 'ended';

// ============================================
// GAME ROOM MANAGER
// ============================================

class PurgeGameRoom {
  public gameId: string;
  public players: Map<string, PlayerState> = new Map();
  public connections: Map<string, ClientConnection> = new Map();
  public phase: GamePhase = 'waiting';
  public createdAt: number = Date.now();
  public countdownTimer: NodeJS.Timeout | null = null;
  public gameTimer: NodeJS.Timeout | null = null;
  public readyPlayers: Set<string> = new Set();
  public countdownStartTime: number | null = null;
  public countdownDuration: number = 15000; // 15 seconds
  public gameDuration: number = 30 * 60 * 1000; // 30 minutes

  constructor(gameId: string) {
    this.gameId = gameId;
    console.log(`[Room ${gameId}] 🎮 Created`);

    // Start 30-second auto-countdown
    setTimeout(() => {
      if (this.phase === 'waiting' && this.players.size > 0) {
        console.log(`[Room ${gameId}] ⏰ 30s elapsed, auto-starting countdown`);
        this.startCountdown();
      }
    }, 30000);
  }

  addPlayer(playerId: string, connection: ClientConnection): void {
    console.log(`[Room ${this.gameId}] 👤 Player joined: ${playerId.slice(0, 8)} (${this.players.size + 1} total)`);

    // Initialize player state
    const playerState: PlayerState = {
      id: playerId,
      x: 400 + Math.random() * 400 - 200,
      y: 300 + Math.random() * 300 - 150,
      size: 10,
      score: 0,
      color: this.generatePlayerColor(),
      ready: false,
      eliminated: false,
      timestamp: Date.now()
    };

    this.players.set(playerId, playerState);
    this.connections.set(playerId, connection);

    // Send full sync to new player
    this.sendToPlayer(playerId, {
      type: 'sync',
      players: Array.from(this.players.values())
    });

    // Broadcast to others that player joined
    this.broadcast({
      type: 'player:joined',
      playerId,
      state: playerState
    }, playerId);

    // Send current game state
    this.sendGameStateUpdate();
  }

  removePlayer(playerId: string): void {
    console.log(`[Room ${this.gameId}] 👋 Player left: ${playerId.slice(0, 8)}`);

    this.players.delete(playerId);
    this.connections.delete(playerId);
    this.readyPlayers.delete(playerId);

    // Broadcast to others
    this.broadcast({
      type: 'player:left',
      playerId
    });

    this.sendGameStateUpdate();

    // Clean up if empty
    if (this.players.size === 0) {
      this.cleanup();
    }
  }

  handlePlayerUpdate(playerId: string, update: Partial<PlayerState>): void {
    const player = this.players.get(playerId);
    if (!player || player.eliminated) return;

    // Update player state
    Object.assign(player, update, {
      id: playerId, // Preserve ID
      timestamp: Date.now()
    });

    // Broadcast to all except sender
    this.broadcast({
      type: 'player:update',
      playerId,
      state: update
    }, playerId);
  }

  handlePlayerReady(playerId: string): void {
    console.log(`[Room ${this.gameId}] ✅ Player ready: ${playerId.slice(0, 8)}`);

    const player = this.players.get(playerId);
    if (!player) return;

    player.ready = true;
    this.readyPlayers.add(playerId);

    // Broadcast ready status
    this.broadcast({
      type: 'player:ready',
      playerId
    });

    this.sendGameStateUpdate();

    // Check if should start countdown
    const allReady = this.readyPlayers.size === this.players.size;
    const timeSinceCreation = Date.now() - this.createdAt;

    if (this.phase === 'waiting' && (allReady || timeSinceCreation > 30000)) {
      this.startCountdown();
    }
  }

  handlePlayerEliminated(playerId: string): void {
    console.log(`[Room ${this.gameId}] 💀 Player eliminated: ${playerId.slice(0, 8)}`);

    const player = this.players.get(playerId);
    if (!player) return;

    player.eliminated = true;

    this.broadcast({
      type: 'player:eliminated',
      playerId
    });

    // Check if game should end
    const activePlayers = Array.from(this.players.values()).filter(p => !p.eliminated);
    if (activePlayers.length === 1 && this.phase === 'active') {
      this.endGame(activePlayers[0].id);
    }
  }

  startCountdown(): void {
    if (this.phase !== 'waiting') return;

    console.log(`[Room ${this.gameId}] ⏱️ Starting countdown (${this.countdownDuration / 1000}s)`);

    this.phase = 'countdown';
    this.countdownStartTime = Date.now();

    // Broadcast countdown start
    this.broadcast({
      type: 'game:countdown',
      startTime: this.countdownStartTime,
      duration: this.countdownDuration
    });

    this.sendGameStateUpdate();

    // Start game after countdown
    this.countdownTimer = setTimeout(() => {
      this.startGame();
    }, this.countdownDuration);
  }

  startGame(): void {
    if (this.phase !== 'countdown') return;

    console.log(`[Room ${this.gameId}] 🚀 Game starting!`);

    this.phase = 'active';

    this.broadcast({ type: 'game:start' });
    this.sendGameStateUpdate();

    // Set game timer
    this.gameTimer = setTimeout(() => {
      this.timeExpired();
    }, this.gameDuration);
  }

  timeExpired(): void {
    console.log(`[Room ${this.gameId}] ⏰ Time expired`);

    // Find player with highest score
    const players = Array.from(this.players.values()).filter(p => !p.eliminated);
    const winner = players.sort((a, b) => (b.score || 0) - (a.score || 0))[0];

    if (winner) {
      this.endGame(winner.id);
    }
  }

  endGame(winnerId: string): void {
    if (this.phase === 'ended') return;

    console.log(`[Room ${this.gameId}] 🏆 Game ended, winner: ${winnerId.slice(0, 8)}`);

    this.phase = 'ended';

    this.broadcast({
      type: 'game:end',
      winnerId
    });

    this.sendGameStateUpdate();

    // Cleanup after 10 seconds
    setTimeout(() => {
      this.cleanup();
    }, 10000);
  }

  sendGameStateUpdate(): void {
    const activePlayers = Array.from(this.players.values()).filter(p => !p.eliminated);

    this.broadcast({
      type: 'game_state_update',
      gameState: {
        phase: this.phase,
        countdownStartTime: this.countdownStartTime,
        countdownDuration: this.countdownDuration,
        readyPlayers: this.readyPlayers.size,
        totalPlayers: this.players.size,
        activePlayers: activePlayers.length
      }
    });
  }

  sendToPlayer(playerId: string, message: any): void {
    const conn = this.connections.get(playerId);
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      try {
        conn.ws.send(JSON.stringify(message));
      } catch (error) {
        console.error(`[Room ${this.gameId}] ❌ Failed to send to ${playerId.slice(0, 8)}:`, error);
      }
    }
  }

  broadcast(message: any, excludePlayerId?: string): void {
    this.connections.forEach((conn, playerId) => {
      if (playerId !== excludePlayerId && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(JSON.stringify(message));
        } catch (error) {
          console.error(`[Room ${this.gameId}] ❌ Broadcast error for ${playerId.slice(0, 8)}:`, error);
        }
      }
    });
  }

  cleanup(): void {
    console.log(`[Room ${this.gameId}] 🧹 Cleaning up`);

    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }

    if (this.gameTimer) {
      clearTimeout(this.gameTimer);
      this.gameTimer = null;
    }

    // Close all connections
    this.connections.forEach(conn => {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close(1000, 'Game ended');
      }
    });

    this.connections.clear();
    this.players.clear();
    this.readyPlayers.clear();
  }

  private generatePlayerColor(): string {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
      '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2',
      '#F8B195', '#C06C84', '#6C5B7B', '#355C7D'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }
}

// ============================================
// GAME ROOM REGISTRY
// ============================================

const gameRooms = new Map<string, PurgeGameRoom>();

function getOrCreateRoom(gameId: string): PurgeGameRoom {
  let room = gameRooms.get(gameId);
  if (!room) {
    room = new PurgeGameRoom(gameId);
    gameRooms.set(gameId, room);
  }
  return room;
}

// ============================================
// WEBSOCKET SERVER
// ============================================

const wss = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024
  }
});

// Heartbeat interval
const HEARTBEAT_INTERVAL = 30000;
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws: any) => {
    if (!ws.isAlive) {
      console.log('[WS] 💀 Client timeout, terminating');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on('connection', (ws: WebSocket, request: any) => {
  const { query } = parse(request.url, true);
  const gameId = query.gameId as string;
  const playerId = query.playerId as string;

  if (!gameId || !playerId) {
    console.error('[WS] ❌ Missing gameId or playerId');
    ws.close(1008, 'Missing parameters');
    return;
  }

  console.log(`[WS] ✅ New connection: game=${gameId.slice(0, 8)}, player=${playerId.slice(0, 8)}`);

  // Setup connection
  const connection: ClientConnection = {
    ws,
    playerId,
    gameId,
    lastUpdate: Date.now(),
    isAlive: true
  };

  (ws as any).isAlive = true;
  (ws as any).playerId = playerId;
  (ws as any).gameId = gameId;

  // Add to room
  const room = getOrCreateRoom(gameId);
  room.addPlayer(playerId, connection);

  // Pong handler
  ws.on('pong', () => {
    (ws as any).isAlive = true;
  });

  // Message handler
  ws.on('message', (data: Buffer) => {
    connection.lastUpdate = Date.now();

    try {
      const message = JSON.parse(data.toString());
      handleMessage(room, playerId, message, ws);
    } catch (error) {
      console.error('[WS] ❌ Parse error:', error);
    }
  });

  // Close handler
  ws.on('close', (code, reason) => {
    console.log(`[WS] 🔌 Disconnected: player=${playerId.slice(0, 8)}, code=${code}, reason=${reason}`);
    room.removePlayer(playerId);
  });

  // Error handler
  ws.on('error', (error) => {
    console.error('[WS] ❌ Error:', error);
  });
});

// ============================================
// MESSAGE HANDLER
// ============================================

function handleMessage(room: PurgeGameRoom, playerId: string, message: any, ws: WebSocket): void {
  switch (message.type) {
    case 'sync_request':
      room.sendToPlayer(playerId, {
        type: 'sync',
        players: Array.from(room.players.values())
      });
      break;

    case 'player:ready':
      room.handlePlayerReady(playerId);
      break;

    case 'player:update':
      room.handlePlayerUpdate(playerId, message.state);

      // Send acknowledgement
      if (message.sequence !== undefined) {
        room.sendToPlayer(playerId, {
          type: 'update_ack',
          sequence: message.sequence
        });
      }
      break;

    case 'player:eliminated':
      room.handlePlayerEliminated(playerId);
      break;

    case 'ping':
      room.sendToPlayer(playerId, { type: 'pong' });
      break;

    case 'heartbeat':
      // Just acknowledge
      break;

    default:
      console.log(`[WS] ❓ Unknown message type: ${message.type}`);
  }
}

// ============================================
// HTTP SERVER UPGRADE
// ============================================

server.on('upgrade', (request, socket, head) => {
  const { pathname } = parse(request.url);

  if (pathname === '/game') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ============================================
// REST API ENDPOINTS
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: gameRooms.size,
    connections: Array.from(gameRooms.values()).reduce((sum, room) => sum + room.connections.size, 0)
  });
});

app.get('/stats', (req, res) => {
  const stats = Array.from(gameRooms.entries()).map(([gameId, room]) => ({
    gameId,
    phase: room.phase,
    players: room.players.size,
    readyPlayers: room.readyPlayers.size,
    activePlayers: Array.from(room.players.values()).filter(p => !p.eliminated).length
  }));

  res.json({
    totalRooms: gameRooms.size,
    rooms: stats
  });
});

// ============================================
// CLEANUP & STARTUP
// ============================================

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, cleaning up...');
  clearInterval(heartbeatTimer);

  gameRooms.forEach(room => room.cleanup());

  wss.close(() => {
    server.close(() => {
      console.log('👋 Server closed gracefully');
      process.exit(0);
    });
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Purge Multiplayer Server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/game`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
});

export default app;