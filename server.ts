// backend/src/server.ts - Professional WebSocket Server for Phase 3 Multiplayer

import WebSocket, { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

// ============================================================================
// TYPES
// ============================================================================

interface PlayerState {
  id: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  hasShield: boolean;
  hasSpeed: boolean;
  name: string;
  color: string;
  radius: number;
  vx: number;
  vy: number;
}

interface ClientConnection {
  ws: WebSocket;
  playerId: string;
  gameId: number;
  lastHeartbeat: number;
  isAlive: boolean;
}

interface GameSession {
  gameId: number;
  phase: 'waiting' | 'countdown' | 'active' | 'ended';
  countdownStartTime: number | null;
  countdownDuration: number;
  players: Map<string, PlayerState>;
  readyPlayers: Set<string>;
  startTime: number | null;
  winner: string | null;
}

// ============================================================================
// GAME MANAGER - Core Business Logic
// ============================================================================

class GameManager {
  private games: Map<number, GameSession> = new Map();
  private gameTimers: Map<number, NodeJS.Timeout> = new Map();

  getOrCreateGame(gameId: number): GameSession {
    if (!this.games.has(gameId)) {
      this.games.set(gameId, {
        gameId,
        phase: 'waiting',
        countdownStartTime: null,
        countdownDuration: 15000,
        players: new Map(),
        readyPlayers: new Set(),
        startTime: null,
        winner: null
      });
      console.log(`[GameManager] Created new game session: ${gameId}`);
    }
    return this.games.get(gameId)!;
  }

  addPlayer(gameId: number, playerId: string): void {
    const game = this.getOrCreateGame(gameId);

    if (!game.players.has(playerId)) {
      console.log(`[GameManager] Player ${playerId.slice(0, 8)} joined game ${gameId}`);
    }
  }

  removePlayer(gameId: number, playerId: string): void {
    const game = this.games.get(gameId);
    if (!game) return;

    game.players.delete(playerId);
    game.readyPlayers.delete(playerId);

    console.log(`[GameManager] Player ${playerId.slice(0, 8)} left game ${gameId}`);

    if (game.players.size === 0) {
      this.clearGameTimer(gameId);
      this.games.delete(gameId);
      console.log(`[GameManager] Game ${gameId} deleted (no players)`);
    }
  }

  updatePlayerState(gameId: number, playerId: string, state: PlayerState): void {
    const game = this.games.get(gameId);
    if (!game) return;

    game.players.set(playerId, state);
  }

  markPlayerReady(gameId: number, playerId: string): void {
    const game = this.getOrCreateGame(gameId);
    game.readyPlayers.add(playerId);

    console.log(`[GameManager] Player ${playerId.slice(0, 8)} marked ready in game ${gameId}`);
    console.log(`[GameManager] Ready count: ${game.readyPlayers.size}/${game.players.size}`);
  }

  canStartGame(gameId: number): { canStart: boolean; reason: string; readyCount: number } {
    const game = this.games.get(gameId);
    if (!game) {
      return { canStart: false, reason: 'Game not found', readyCount: 0 };
    }

    const readyCount = game.readyPlayers.size;

    if (game.phase !== 'waiting') {
      return { canStart: false, reason: `Game already in phase: ${game.phase}`, readyCount };
    }

    if (readyCount === 0) {
      return { canStart: false, reason: 'No players ready', readyCount: 0 };
    }

    if (readyCount === 1) {
      return { canStart: true, reason: 'Auto-winner (1 player ready)', readyCount: 1 };
    }

    return { canStart: true, reason: `${readyCount} players ready for battle`, readyCount };
  }

  startGame(gameId: number): { success: boolean; message: string; gameState?: GameSession } {
    const game = this.games.get(gameId);
    if (!game) {
      return { success: false, message: 'Game not found' };
    }

    const { canStart, reason, readyCount } = this.canStartGame(gameId);

    if (!canStart) {
      return { success: false, message: reason };
    }

    if (readyCount === 1) {
      const winnerId = Array.from(game.readyPlayers)[0];
      game.phase = 'ended';
      game.winner = winnerId;
      console.log(`[GameManager] Auto-winner declared: ${winnerId.slice(0, 8)}`);
      return { success: true, message: 'Auto-winner declared', gameState: game };
    }

    game.phase = 'countdown';
    game.countdownStartTime = Date.now();

    console.log(`[GameManager] Game ${gameId} starting countdown with ${readyCount} players`);

    const countdownTimer = setTimeout(() => {
      this.transitionToActive(gameId);
    }, game.countdownDuration);

    this.gameTimers.set(gameId, countdownTimer);

    return { success: true, message: 'Countdown started', gameState: game };
  }

  private transitionToActive(gameId: number): void {
    const game = this.games.get(gameId);
    if (!game) return;

    game.phase = 'active';
    game.startTime = Date.now();

    console.log(`[GameManager] Game ${gameId} transitioned to ACTIVE phase`);
  }

  declareWinner(gameId: number, winnerId: string): void {
    const game = this.games.get(gameId);
    if (!game) return;

    game.phase = 'ended';
    game.winner = winnerId;

    this.clearGameTimer(gameId);

    console.log(`[GameManager] Winner declared for game ${gameId}: ${winnerId.slice(0, 8)}`);
  }

  getGameState(gameId: number): GameSession | undefined {
    return this.games.get(gameId);
  }

  private clearGameTimer(gameId: number): void {
    const timer = this.gameTimers.get(gameId);
    if (timer) {
      clearTimeout(timer);
      this.gameTimers.delete(gameId);
    }
  }
}

// ============================================================================
// CONNECTION MANAGER - WebSocket Connection Handling
// ============================================================================

class ConnectionManager {
  private connections: Map<string, ClientConnection> = new Map();
  private gameConnections: Map<number, Set<string>> = new Map();

  addConnection(ws: WebSocket, playerId: string, gameId: number): void {
    const connectionId = `${gameId}-${playerId}`;

    this.connections.set(connectionId, {
      ws,
      playerId,
      gameId,
      lastHeartbeat: Date.now(),
      isAlive: true
    });

    if (!this.gameConnections.has(gameId)) {
      this.gameConnections.set(gameId, new Set());
    }
    this.gameConnections.get(gameId)!.add(connectionId);

    console.log(`[ConnectionManager] Connection added: ${connectionId}`);
  }

  removeConnection(playerId: string, gameId: number): void {
    const connectionId = `${gameId}-${playerId}`;

    this.connections.delete(connectionId);

    const gameConns = this.gameConnections.get(gameId);
    if (gameConns) {
      gameConns.delete(connectionId);
      if (gameConns.size === 0) {
        this.gameConnections.delete(gameId);
      }
    }

    console.log(`[ConnectionManager] Connection removed: ${connectionId}`);
  }

  updateHeartbeat(playerId: string, gameId: number): void {
    const connectionId = `${gameId}-${playerId}`;
    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.lastHeartbeat = Date.now();
      conn.isAlive = true;
    }
  }

  broadcastToGame(gameId: number, message: any, excludePlayerId?: string): void {
    const gameConns = this.gameConnections.get(gameId);
    if (!gameConns) return;

    const messageStr = JSON.stringify(message);
    let sentCount = 0;

    gameConns.forEach(connectionId => {
      const conn = this.connections.get(connectionId);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        if (!excludePlayerId || conn.playerId !== excludePlayerId) {
          conn.ws.send(messageStr);
          sentCount++;
        }
      }
    });

    console.log(`[ConnectionManager] Broadcasted ${message.type} to ${sentCount} players in game ${gameId}`);
  }

  sendToPlayer(playerId: string, gameId: number, message: any): void {
    const connectionId = `${gameId}-${playerId}`;
    const conn = this.connections.get(connectionId);

    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(message));
    }
  }

  getGamePlayerIds(gameId: number): string[] {
    const gameConns = this.gameConnections.get(gameId);
    if (!gameConns) return [];

    return Array.from(gameConns)
      .map(connId => this.connections.get(connId)?.playerId)
      .filter(id => id !== undefined) as string[];
  }

  checkStaleConnections(): void {
    const now = Date.now();
    const staleTimeout = 60000;

    this.connections.forEach((conn, connectionId) => {
      if (now - conn.lastHeartbeat > staleTimeout) {
        console.log(`[ConnectionManager] Stale connection detected: ${connectionId}`);
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.close();
        }
        this.removeConnection(conn.playerId, conn.gameId);
      }
    });
  }
}

// ============================================================================
// MESSAGE HANDLER - Process Client Messages
// ============================================================================

class MessageHandler {
  constructor(
    private gameManager: GameManager,
    private connectionManager: ConnectionManager
  ) { }

  handleMessage(playerId: string, gameId: number, message: any): void {
    try {
      switch (message.type) {
        case 'heartbeat':
          this.handleHeartbeat(playerId, gameId);
          break;

        case 'mark_ready':
          this.handleMarkReady(playerId, gameId);
          break;

        case 'start_game':
          this.handleStartGame(playerId, gameId);
          break;

        case 'update':
          this.handlePlayerUpdate(playerId, gameId, message.data);
          break;

        case 'eliminated':
          this.handleEliminated(playerId, gameId);
          break;

        case 'winner':
          this.handleWinner(gameId, message.winnerId);
          break;

        default:
          console.log(`[MessageHandler] Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error('[MessageHandler] Error processing message:', error);
    }
  }

  private handleHeartbeat(playerId: string, gameId: number): void {
    this.connectionManager.updateHeartbeat(playerId, gameId);
  }

  private handleMarkReady(playerId: string, gameId: number): void {
    this.gameManager.markPlayerReady(gameId, playerId);

    const game = this.gameManager.getGameState(gameId);
    if (game) {
      this.broadcastGameState(gameId);
    }
  }

  private handleStartGame(playerId: string, gameId: number): void {
    console.log(`[MessageHandler] Player ${playerId.slice(0, 8)} requesting game start`);

    const result = this.gameManager.startGame(gameId);

    if (result.success && result.gameState) {
      this.broadcastGameState(gameId);

      if (result.gameState.phase === 'ended') {
        this.connectionManager.broadcastToGame(gameId, {
          type: 'winner',
          winnerId: result.gameState.winner
        });
      }
    } else {
      this.connectionManager.sendToPlayer(playerId, gameId, {
        type: 'error',
        message: result.message
      });
    }
  }

  private handlePlayerUpdate(playerId: string, gameId: number, state: PlayerState): void {
    this.gameManager.updatePlayerState(gameId, playerId, state);

    this.connectionManager.broadcastToGame(
      gameId,
      {
        type: 'update',
        playerId,
        data: state
      },
      playerId
    );
  }

  private handleEliminated(playerId: string, gameId: number): void {
    console.log(`[MessageHandler] Player ${playerId.slice(0, 8)} eliminated`);

    this.connectionManager.broadcastToGame(gameId, {
      type: 'eliminated',
      playerId
    });

    const game = this.gameManager.getGameState(gameId);
    if (game && game.phase === 'active') {
      const alivePlayers = Array.from(game.players.values()).filter(p => p.alive);

      if (alivePlayers.length <= 1 && alivePlayers.length > 0) {
        const winner = alivePlayers[0];
        this.gameManager.declareWinner(gameId, winner.id);
        this.connectionManager.broadcastToGame(gameId, {
          type: 'winner',
          winnerId: winner.id
        });
      }
    }
  }

  private handleWinner(gameId: number, winnerId: string): void {
    console.log(`[MessageHandler] Winner declared: ${winnerId.slice(0, 8)}`);

    this.gameManager.declareWinner(gameId, winnerId);

    this.connectionManager.broadcastToGame(gameId, {
      type: 'winner',
      winnerId
    });
  }

  private broadcastGameState(gameId: number): void {
    const game = this.gameManager.getGameState(gameId);
    if (!game) return;

    this.connectionManager.broadcastToGame(gameId, {
      type: 'game_state_update',
      gameState: {
        phase: game.phase,
        countdownStartTime: game.countdownStartTime,
        countdownDuration: game.countdownDuration,
        readyPlayers: game.readyPlayers.size,
        totalPlayers: this.connectionManager.getGamePlayerIds(gameId).length
      }
    });
  }
}

// ============================================================================
// WEBSOCKET SERVER - Main Server Implementation
// ============================================================================

class Phase3WebSocketServer {
  private wss: WebSocketServer;
  private gameManager: GameManager;
  private connectionManager: ConnectionManager;
  private messageHandler: MessageHandler;

  constructor(port: number = 3001) {
    this.gameManager = new GameManager();
    this.connectionManager = new ConnectionManager();
    this.messageHandler = new MessageHandler(this.gameManager, this.connectionManager);

    const server = createServer();
    this.wss = new WebSocketServer({ server });

    this.setupWebSocketServer();
    this.startHealthCheck();

    server.listen(port, () => {
      console.log(`[Server] Phase 3 WebSocket server running on port ${port}`);
    });
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket, request) => {
      const { query } = parse(request.url || '', true);
      const gameId = parseInt(query.gameId as string);
      const playerId = query.playerId as string;

      if (!gameId || !playerId) {
        console.error('[Server] Invalid connection parameters');
        ws.close(1008, 'Invalid parameters');
        return;
      }

      console.log(`[Server] New connection: Player ${playerId.slice(0, 8)} -> Game ${gameId}`);

      this.connectionManager.addConnection(ws, playerId, gameId);
      this.gameManager.addPlayer(gameId, playerId);

      this.sendInitialGameState(ws, gameId);

      this.connectionManager.broadcastToGame(
        gameId,
        {
          type: 'player_connected',
          playerId
        },
        playerId
      );

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.messageHandler.handleMessage(playerId, gameId, message);
        } catch (error) {
          console.error('[Server] Error parsing message:', error);
        }
      });

      ws.on('close', () => {
        console.log(`[Server] Player ${playerId.slice(0, 8)} disconnected from game ${gameId}`);

        this.connectionManager.removeConnection(playerId, gameId);
        this.gameManager.removePlayer(gameId, playerId);

        this.connectionManager.broadcastToGame(gameId, {
          type: 'player_disconnected',
          playerId
        });
      });

      ws.on('error', (error) => {
        console.error(`[Server] WebSocket error for player ${playerId.slice(0, 8)}:`, error);
      });
    });
  }

  private sendInitialGameState(ws: WebSocket, gameId: number): void {
    const game = this.gameManager.getGameState(gameId);
    if (!game) return;

    const message = {
      type: 'game_state_update',
      gameState: {
        phase: game.phase,
        countdownStartTime: game.countdownStartTime,
        countdownDuration: game.countdownDuration,
        readyPlayers: game.readyPlayers.size,
        totalPlayers: this.connectionManager.getGamePlayerIds(gameId).length
      }
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }

    if (game.players.size > 0) {
      const players = Array.from(game.players.values());
      const syncMessage = {
        type: 'sync',
        players
      };

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(syncMessage));
      }
    }
  }

  private startHealthCheck(): void {
    setInterval(() => {
      this.connectionManager.checkStaleConnections();
    }, 30000);

    console.log('[Server] Health check started');
  }
}

// ============================================================================
// START SERVER
// ============================================================================

const PORT = parseInt(process.env.WS_PORT || '3001');
new Phase3WebSocketServer(PORT);

export { Phase3WebSocketServer, GameManager, ConnectionManager, MessageHandler };