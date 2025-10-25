// backend/src/server.ts - COMPLETE WebSocket Server with ALL Features + Sync Fixes

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
  trail?: Array<{ x: number; y: number; alpha: number }>;
  pulsePhase?: number;
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

interface BattleMove {
  playerId: string;
  move: string;
  round: number;
  submittedAt: number;
}

interface BattleSession {
  challengeId: string;
  players: Set<string>;
  connections: Map<string, WebSocket>;
  moves: Map<number, BattleMove[]>;
  status: 'waiting' | 'ready' | 'in_progress' | 'ended';
  winner: string | null;
  createdAt: number;
}

// ============================================================================
// PHASE 3 GAME MANAGER
// ============================================================================

class GameManager {
  private games: Map<number, GameSession> = new Map();
  private gameTimers: Map<number, NodeJS.Timeout> = new Map();
  private onGameStateChange?: (gameId: number) => void;

  setGameStateChangeCallback(callback: (gameId: number) => void) {
    this.onGameStateChange = callback;
  }

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
      console.log(`[GameManager] ✅ Created new game session: ${gameId}`);
    }
    return this.games.get(gameId)!;
  }

  addPlayer(gameId: number, playerId: string): void {
    const game = this.getOrCreateGame(gameId);

    if (!game.players.has(playerId)) {
      console.log(`[GameManager] ✅ Player ${playerId.slice(0, 8)} joined game ${gameId}`);
    }
  }

  removePlayer(gameId: number, playerId: string): void {
    const game = this.games.get(gameId);
    if (!game) return;

    game.players.delete(playerId);
    game.readyPlayers.delete(playerId);

    console.log(`[GameManager] 👋 Player ${playerId.slice(0, 8)} left game ${gameId}`);

    if (game.players.size === 0) {
      this.clearGameTimer(gameId);
      this.games.delete(gameId);
      console.log(`[GameManager] 🧹 Game ${gameId} deleted (no players)`);
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

    console.log(`[GameManager] ✅ Player ${playerId.slice(0, 8)} marked ready in game ${gameId}`);
    console.log(`[GameManager] 📊 Ready count: ${game.readyPlayers.size}/${game.players.size}`);

    if (this.onGameStateChange) {
      this.onGameStateChange(gameId);
    }
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
      console.log(`[GameManager] 🏆 Auto-winner declared: ${winnerId.slice(0, 8)}`);
      return { success: true, message: 'Auto-winner declared', gameState: game };
    }

    game.phase = 'countdown';
    game.countdownStartTime = Date.now();

    console.log(`[GameManager] 🚀 Game ${gameId} starting countdown with ${readyCount} players`);

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

    console.log(`[GameManager] 🎮 Game ${gameId} transitioned to ACTIVE phase`);

    if (this.onGameStateChange) {
      this.onGameStateChange(gameId);
    }
  }

  declareWinner(gameId: number, winnerId: string): void {
    const game = this.games.get(gameId);
    if (!game) return;

    game.phase = 'ended';
    game.winner = winnerId;

    this.clearGameTimer(gameId);

    console.log(`[GameManager] 🏆 Winner declared for game ${gameId}: ${winnerId.slice(0, 8)}`);
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
// CONNECTION MANAGER - ✅ FIXED: Better sync handling
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

    console.log(`[ConnectionManager] ✅ Connection added: ${connectionId}`);
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

    console.log(`[ConnectionManager] 👋 Connection removed: ${connectionId}`);
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
      if (conn && conn.playerId !== excludePlayerId && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(messageStr);
        sentCount++;
      }
    });

    // ✅ FIX: Log pentru debugging
    if (message.type === 'player_state_update' || message.type === 'sync') {
      console.log(`[ConnectionManager] 📡 Broadcast ${message.type} to game ${gameId}: ${sentCount} recipients`);
    }
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
      .map(connectionId => {
        const conn = this.connections.get(connectionId);
        return conn?.playerId;
      })
      .filter(Boolean) as string[];
  }

  checkStaleConnections(): void {
    const now = Date.now();
    const staleThreshold = 60000; // 1 minute

    this.connections.forEach((conn, connectionId) => {
      if (now - conn.lastHeartbeat > staleThreshold) {
        console.log(`[ConnectionManager] ⚠️ Stale connection detected: ${connectionId}`);

        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.close();
        }

        this.removeConnection(conn.playerId, conn.gameId);
      }
    });
  }
}

// ============================================================================
// MESSAGE HANDLER - ✅ FIXED: Better state broadcasting
// ============================================================================

class MessageHandler {
  constructor(
    private gameManager: GameManager,
    private connectionManager: ConnectionManager
  ) { }

  handleMessage(playerId: string, gameId: number, message: any): void {
    console.log(`[MessageHandler] 📨 ${message.type} from ${playerId.slice(0, 8)} in game ${gameId}`);

    switch (message.type) {
      case 'heartbeat':
        this.handleHeartbeat(playerId, gameId);
        break;

      case 'mark_ready':
        this.handleMarkReady(playerId, gameId);
        break;

      case 'player_state_update':
        this.handlePlayerStateUpdate(playerId, gameId, message.state);
        break;

      case 'start_game':
        this.handleStartGame(playerId, gameId);
        break;

      case 'player_eliminated':
        this.handlePlayerEliminated(playerId, gameId);
        break;

      case 'declare_winner':
        this.handleDeclareWinner(playerId, gameId, message.winnerId);
        break;

      case 'request_sync':
        this.handleRequestSync(playerId, gameId);
        break;

      default:
        console.warn(`[MessageHandler] ⚠️ Unknown message type: ${message.type}`);
    }
  }

  private handleHeartbeat(playerId: string, gameId: number): void {
    this.connectionManager.updateHeartbeat(playerId, gameId);
    this.connectionManager.sendToPlayer(playerId, gameId, { type: 'heartbeat_ack' });
  }

  private handleMarkReady(playerId: string, gameId: number): void {
    this.gameManager.markPlayerReady(gameId, playerId);

    this.connectionManager.broadcastToGame(gameId, {
      type: 'player_ready',
      playerId
    });
  }

  private handlePlayerStateUpdate(playerId: string, gameId: number, state: PlayerState): void {
    if (!state || !state.id) {
      console.warn(`[MessageHandler] ⚠️ Invalid state from ${playerId.slice(0, 8)}`);
      return;
    }

    this.gameManager.updatePlayerState(gameId, playerId, state);

    // ✅ FIX: Broadcast state immediately to all other players
    this.connectionManager.broadcastToGame(
      gameId,
      {
        type: 'player_state_update',
        playerId,
        state
      },
      playerId // exclude sender
    );
  }

  private handleStartGame(playerId: string, gameId: number): void {
    const result = this.gameManager.startGame(gameId);

    if (result.success) {
      this.connectionManager.broadcastToGame(gameId, {
        type: 'game_started',
        gameState: result.gameState
      });
    } else {
      this.connectionManager.sendToPlayer(playerId, gameId, {
        type: 'game_start_failed',
        reason: result.message
      });
    }
  }

  private handlePlayerEliminated(playerId: string, gameId: number): void {
    const game = this.gameManager.getGameState(gameId);
    if (!game) return;

    const playerState = game.players.get(playerId);
    if (playerState) {
      playerState.alive = false;
      this.gameManager.updatePlayerState(gameId, playerId, playerState);
    }

    console.log(`[MessageHandler] 💀 Player ${playerId.slice(0, 8)} eliminated in game ${gameId}`);

    this.connectionManager.broadcastToGame(gameId, {
      type: 'player_eliminated',
      playerId
    });

    // Check if winner should be declared
    const alivePlayers = Array.from(game.players.values()).filter(p => p.alive);
    if (alivePlayers.length === 1) {
      this.handleDeclareWinner(playerId, gameId, alivePlayers[0].id);
    } else if (alivePlayers.length === 0) {
      console.warn(`[MessageHandler] ⚠️ No alive players in game ${gameId}`);
    }
  }

  private handleDeclareWinner(playerId: string, gameId: number, winnerId: string): void {
    this.gameManager.declareWinner(gameId, winnerId);

    console.log(`[MessageHandler] 🏆 Winner declared: ${winnerId.slice(0, 8)}`);

    this.connectionManager.broadcastToGame(gameId, {
      type: 'winner_declared',
      winnerId
    });
  }

  private handleRequestSync(playerId: string, gameId: number): void {
    const game = this.gameManager.getGameState(gameId);
    if (!game) return;

    // ✅ FIX: Send complete game state to requesting player
    const players = Array.from(game.players.values());

    this.connectionManager.sendToPlayer(playerId, gameId, {
      type: 'sync',
      players: players.filter(p => p.id !== playerId) // Don't send player's own state
    });

    console.log(`[MessageHandler] 📊 Sent sync to ${playerId.slice(0, 8)}: ${players.length - 1} other players`);
  }
}

// ============================================================================
// BATTLE MANAGER (Phase 2 RPS)
// ============================================================================

class BattleManager {
  private battles: Map<string, BattleSession> = new Map();

  handleConnection(ws: WebSocket, challengeId: string, playerId: string) {
    let battle = this.battles.get(challengeId);

    if (!battle) {
      battle = {
        challengeId,
        players: new Set(),
        connections: new Map(),
        moves: new Map(),
        status: 'waiting',
        winner: null,
        createdAt: Date.now()
      };
      this.battles.set(challengeId, battle);
      console.log(`[BattleManager] ✅ Created battle: ${challengeId}`);
    }

    battle.players.add(playerId);
    battle.connections.set(playerId, ws);

    console.log(`[BattleManager] ✅ Player ${playerId.slice(0, 8)} joined battle ${challengeId}`);

    if (battle.players.size === 2 && battle.status === 'waiting') {
      battle.status = 'ready';
      this.broadcastToBattle(challengeId, {
        type: 'battle_ready',
        players: Array.from(battle.players)
      });
    }

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleBattleMessage(challengeId, playerId, msg);
      } catch (err) {
        console.error('[BattleManager] ❌ Parse error:', err);
      }
    });

    ws.on('close', () => {
      this.removePlayer(challengeId, playerId);
    });

    ws.on('error', (err) => {
      console.error(`[BattleManager] ❌ WebSocket error for ${playerId.slice(0, 8)}:`, err);
    });
  }

  private handleBattleMessage(id: string, pid: string, msg: any) {
    const battle = this.battles.get(id);
    if (!battle) return;

    console.log(`[BattleManager] 📨 ${msg.type} from ${pid.slice(0, 8)} in battle ${id}`);

    switch (msg.type) {
      case 'start_battle':
        if (battle.status === 'ready') {
          battle.status = 'in_progress';
          this.broadcastToBattle(id, { type: 'battle_started' });
        }
        break;

      case 'submit_move':
        this.handleMove(id, pid, msg.move, msg.round);
        break;

      case 'heartbeat':
        this.sendTo(battle.connections.get(pid)!, { type: 'heartbeat_ack' });
        break;
    }
  }

  private handleMove(id: string, pid: string, move: string, round: number) {
    const battle = this.battles.get(id);
    if (!battle || battle.status !== 'in_progress') return;

    if (!battle.moves.has(round)) {
      battle.moves.set(round, []);
    }

    const moves = battle.moves.get(round)!;
    moves.push({ playerId: pid, move, round, submittedAt: Date.now() });

    this.broadcastToBattle(id, {
      type: 'move_submitted',
      playerId: pid,
      round
    }, pid);

    if (moves.length === 2) {
      const [m1, m2] = moves;
      const result = this.determineWinner(m1.move, m2.move);

      this.broadcastToBattle(id, {
        type: 'round_result',
        round,
        moves: [
          { playerId: m1.playerId, move: m1.move },
          { playerId: m2.playerId, move: m2.move }
        ],
        winner: result.winner,
        loser: result.loser
      });

      if (result.winner) {
        battle.winner = result.winner;
        battle.status = 'ended';

        this.broadcastToBattle(id, {
          type: 'battle_ended',
          winner: result.winner,
          loser: result.loser
        });
      }
    }
  }

  private determineWinner(m1: string, m2: string): { winner: string | null; loser: string | null } {
    if (m1 === m2) return { winner: null, loser: null };

    const wins: Record<string, string> = {
      rock: 'scissors',
      scissors: 'paper',
      paper: 'rock'
    };

    return wins[m1] === m2
      ? { winner: m1, loser: m2 }
      : { winner: m2, loser: m1 };
  }

  private removePlayer(id: string, pid: string) {
    const battle = this.battles.get(id);
    if (!battle) return;

    battle.players.delete(pid);
    battle.connections.delete(pid);

    console.log(`[BattleManager] 👋 Player ${pid.slice(0, 8)} left battle ${id}`);

    this.broadcastToBattle(id, {
      type: 'player_disconnected',
      playerId: pid
    });

    if (battle.connections.size === 0) {
      this.cleanup(id);
    }
  }

  private sendTo(ws: WebSocket, msg: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcastToBattle(id: string, msg: any, exclude?: string) {
    const battle = this.battles.get(id);
    if (!battle) return;

    battle.connections.forEach((ws, pid) => {
      if (pid !== exclude) {
        this.sendTo(ws, msg);
      }
    });
  }

  private cleanup(id: string) {
    const battle = this.battles.get(id);
    if (!battle) return;

    battle.connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    this.battles.delete(id);
    console.log(`[BattleManager] 🧹 Cleaned up battle: ${id}`);
  }

  startCleanupTimer() {
    setInterval(() => {
      const now = Date.now();
      this.battles.forEach((b, id) => {
        if (now - b.createdAt > 1800000 && b.status !== 'in_progress') {
          this.cleanup(id);
        }
      });
    }, 60000);
  }
}

// ============================================================================
// MAIN UNIFIED SERVER - ✅ FIXED: Better initialization
// ============================================================================

class UnifiedServer {
  private wss: WebSocketServer;
  private gameManager: GameManager;
  private connectionManager: ConnectionManager;
  private messageHandler: MessageHandler;
  private battleManager: BattleManager;
  private gameDeadlineTimers: Map<number, NodeJS.Timeout> = new Map();

  constructor(port: number = 3001) {
    this.gameManager = new GameManager();
    this.connectionManager = new ConnectionManager();
    this.messageHandler = new MessageHandler(this.gameManager, this.connectionManager);
    this.battleManager = new BattleManager();

    const server = createServer();
    this.wss = new WebSocketServer({ server });

    this.gameManager.setGameStateChangeCallback((gameId) => {
      this.broadcastGameState(gameId);
    });

    this.setupWebSocketServer();
    this.startHealthCheck();
    this.battleManager.startCleanupTimer();

    server.listen(port, () => {
      console.log(`[Server] 🚀 Unified WebSocket server running on port ${port}`);
      console.log(`[Server] 📡 Phase 3: ws://localhost:${port}?gameId=X&playerId=Y`);
      console.log(`[Server] ⚔️  Battles: ws://localhost:${port}/battle?challengeId=X&playerId=Y`);
    });
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket, request) => {
      const { pathname, query } = parse(request.url || '', true);

      if (pathname === '/battle') {
        this.handleBattleConnection(ws, query);
      } else {
        this.handlePhase3Connection(ws, query);
      }
    });
  }

  private handleBattleConnection(ws: WebSocket, query: any) {
    const challengeId = query.challengeId as string;
    const playerId = query.playerId as string;

    if (!challengeId || !playerId) {
      console.error('[Server] ❌ Battle - Invalid parameters');
      ws.close(1008, 'Invalid parameters');
      return;
    }

    console.log(`[Server] ⚔️  Battle: ${playerId.slice(0, 8)} -> Challenge ${challengeId}`);
    this.battleManager.handleConnection(ws, challengeId, playerId);
  }

  private handlePhase3Connection(ws: WebSocket, query: any) {
    const gameId = parseInt(query.gameId as string);
    const playerId = query.playerId as string;

    if (!gameId || !playerId) {
      console.error('[Server] ❌ Phase 3 - Invalid parameters');
      ws.close(1008, 'Invalid parameters');
      return;
    }

    console.log(`[Server] 🎮 Phase 3: Player ${playerId.slice(0, 8)} -> Game ${gameId}`);

    this.connectionManager.addConnection(ws, playerId, gameId);
    this.gameManager.addPlayer(gameId, playerId);

    // ✅ FIX: Send initial game state immediately
    this.sendInitialGameState(ws, gameId);

    // ✅ FIX: Notify others AFTER sending initial state
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
        this.handlePhase3Message(playerId, gameId, message);
      } catch (error) {
        console.error('[Server] ❌ Error parsing Phase 3 message:', error);
      }
    });

    ws.on('close', () => {
      console.log(`[Server] 👋 Phase 3: Player ${playerId.slice(0, 8)} disconnected from game ${gameId}`);

      this.connectionManager.removeConnection(playerId, gameId);
      this.gameManager.removePlayer(gameId, playerId);

      this.connectionManager.broadcastToGame(gameId, {
        type: 'player_disconnected',
        playerId
      });
    });

    ws.on('error', (error) => {
      console.error(`[Server] ❌ Phase 3 WebSocket error for player ${playerId.slice(0, 8)}:`, error);
    });
  }

  private handlePhase3Message(playerId: string, gameId: number, message: any): void {
    if (message.type === 'set_deadline') {
      this.startDeadlineMonitor(gameId, message.deadline);
    } else {
      this.messageHandler.handleMessage(playerId, gameId, message);

      if (message.type === 'mark_ready') {
        this.checkAutoStart(gameId);
      }
    }
  }

  private checkAutoStart(gameId: number): void {
    const { canStart, readyCount } = this.gameManager.canStartGame(gameId);

    if (canStart) {
      console.log(`[Server] 🚀 Auto-starting game ${gameId} - ${readyCount} players ready`);

      setTimeout(() => {
        const result = this.gameManager.startGame(gameId);
        if (result.success) {
          this.broadcastGameState(gameId);
        }
      }, 1000);
    }
  }

  private startDeadlineMonitor(gameId: number, deadline: number): void {
    const existingTimer = this.gameDeadlineTimers.get(gameId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const now = Date.now();
    const timeUntilDeadline = deadline - now;

    if (timeUntilDeadline <= 0) {
      this.checkAutoStart(gameId);
      return;
    }

    console.log(`[Server] ⏰ Deadline monitor for game ${gameId} - ${Math.round(timeUntilDeadline / 1000)}s`);

    const timer = setTimeout(() => {
      console.log(`[Server] ⏰ Deadline expired for game ${gameId}, auto-starting...`);
      this.checkAutoStart(gameId);
    }, timeUntilDeadline);

    this.gameDeadlineTimers.set(gameId, timer);
  }

  private sendInitialGameState(ws: WebSocket, gameId: number): void {
    const game = this.gameManager.getGameState(gameId);
    if (!game) return;

    // ✅ FIX: Send game state first
    const stateMessage = {
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
      ws.send(JSON.stringify(stateMessage));
      console.log(`[Server] 📤 Sent initial game state to new player in game ${gameId}`);
    }

    // ✅ FIX: Send existing players sync
    if (game.players.size > 0) {
      const players = Array.from(game.players.values());
      const syncMessage = {
        type: 'sync',
        players
      };

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(syncMessage));
        console.log(`[Server] 📊 Sent player sync: ${players.length} players`);
      }
    }
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

  private startHealthCheck(): void {
    setInterval(() => {
      this.connectionManager.checkStaleConnections();
    }, 30000);

    console.log('[Server] ❤️  Health check started');
  }
}

// ============================================================================
// START SERVER
// ============================================================================

const PORT = parseInt(process.env.PORT || process.env.WS_PORT || '3001');
new UnifiedServer(PORT);