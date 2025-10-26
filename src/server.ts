import WebSocket, { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

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
  expectedPlayers: number; // ✅ NEW: Track how many players should join
  hasStarted: boolean;     // ✅ NEW: Prevent multiple starts
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

class GameManager {
  private games: Map<number, GameSession> = new Map();
  private gameTimers: Map<number, NodeJS.Timeout> = new Map();
  private onGameStateChange?: (gameId: number) => void;

  setGameStateChangeCallback(callback: (gameId: number) => void): void {
    this.onGameStateChange = callback;
  }

  // ✅ FIX: Add expectedPlayers parameter
  getOrCreateGame(gameId: number, expectedPlayers?: number): GameSession {
    if (!this.games.has(gameId)) {
      this.games.set(gameId, {
        gameId,
        phase: 'waiting',
        countdownStartTime: null,
        countdownDuration: 15000,
        players: new Map(),
        readyPlayers: new Set(),
        startTime: null,
        winner: null,
        expectedPlayers: expectedPlayers || 2, // Default to 2 players
        hasStarted: false
      });
      console.log(`[GameManager] ✅ Created game ${gameId} (expecting ${expectedPlayers || 2} players)`);
    }
    return this.games.get(gameId)!;
  }

  // ✅ NEW: Set expected players count (called from frontend)
  setExpectedPlayers(gameId: number, count: number): void {
    const game = this.getOrCreateGame(gameId);
    game.expectedPlayers = count;
    console.log(`[GameManager] 📊 Game ${gameId} expects ${count} players`);
  }

  addPlayer(gameId: number, playerId: string): void {
    const game = this.getOrCreateGame(gameId);
    if (!game.players.has(playerId)) {
      console.log(`[GameManager] 👤 Player ${playerId.slice(0, 8)} joined game ${gameId} (${game.players.size + 1}/${game.expectedPlayers})`);
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
      console.log(`[GameManager] 🗑️ Game ${gameId} deleted (no players)`);
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

    console.log(`[GameManager] ✅ Player ${playerId.slice(0, 8)} ready (${game.readyPlayers.size}/${game.expectedPlayers})`);

    if (this.onGameStateChange) {
      this.onGameStateChange(gameId);
    }
  }

  // ✅ FIX: Updated logic to check against expectedPlayers
  canStartGame(gameId: number): { canStart: boolean; reason: string; readyCount: number } {
    const game = this.games.get(gameId);
    if (!game) {
      return { canStart: false, reason: 'Game not found', readyCount: 0 };
    }

    const readyCount = game.readyPlayers.size;

    // ✅ FIX: Don't start if already started
    if (game.hasStarted) {
      return { canStart: false, reason: 'Game already started', readyCount };
    }

    if (game.phase !== 'waiting') {
      return { canStart: false, reason: `Game already ${game.phase}`, readyCount };
    }

    if (readyCount === 0) {
      return { canStart: false, reason: 'No players ready', readyCount: 0 };
    }

    // ✅ FIX: Only auto-win if there's genuinely 1 player (not just first to connect)
    if (game.expectedPlayers === 1 && readyCount === 1) {
      return { canStart: true, reason: 'Auto-winner (1 expected player)', readyCount: 1 };
    }

    // ✅ FIX: Wait for ALL expected players to be ready
    if (readyCount < game.expectedPlayers) {
      return { canStart: false, reason: `Waiting for ${game.expectedPlayers - readyCount} more players`, readyCount };
    }

    return { canStart: true, reason: `All ${readyCount} players ready`, readyCount };
  }

  // ✅ FIX: Add guard to prevent multiple starts
  startGame(gameId: number): { success: boolean; message: string; gameState?: GameSession } {
    const game = this.games.get(gameId);
    if (!game) {
      return { success: false, message: 'Game not found' };
    }

    // ✅ FIX: Prevent duplicate starts
    if (game.hasStarted) {
      return { success: false, message: 'Game already started' };
    }

    const { canStart, reason, readyCount } = this.canStartGame(gameId);

    if (!canStart) {
      return { success: false, message: reason };
    }

    // ✅ Mark as started IMMEDIATELY to prevent race conditions
    game.hasStarted = true;

    // Handle single-player auto-win (only if truly expected 1 player)
    if (game.expectedPlayers === 1 && readyCount === 1) {
      const winnerId = Array.from(game.readyPlayers)[0];
      game.phase = 'ended';
      game.winner = winnerId;
      console.log(`[GameManager] 🏆 Auto-winner: ${winnerId.slice(0, 8)}`);
      return { success: true, message: 'Auto-winner declared', gameState: game };
    }

    // Normal multi-player game start
    game.phase = 'countdown';
    game.countdownStartTime = Date.now();

    console.log(`[GameManager] ⏱️ Countdown started for game ${gameId} (${readyCount} players)`);

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

    console.log(`[GameManager] 🎮 Game ${gameId} now ACTIVE`);

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

    console.log(`[GameManager] 🏆 Winner: ${winnerId.slice(0, 8)} in game ${gameId}`);
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

    console.log(`[ConnectionManager] 🔌 Connected: ${connectionId}`);
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

    console.log(`[ConnectionManager] 🔌 Disconnected: ${connectionId}`);
  }

  broadcast(message: any, excludePlayerId?: string): void {
    const json = JSON.stringify(message);
    this.connections.forEach((conn, connId) => {
      if (conn.ws.readyState === WebSocket.OPEN && conn.playerId !== excludePlayerId) {
        conn.ws.send(json);
      }
    });
  }

  broadcastToGame(gameId: number, message: any, excludePlayerId?: string): void {
    const json = JSON.stringify(message);
    const gameConns = this.gameConnections.get(gameId);

    if (!gameConns) return;

    gameConns.forEach(connId => {
      const conn = this.connections.get(connId);
      if (conn && conn.ws.readyState === WebSocket.OPEN && conn.playerId !== excludePlayerId) {
        conn.ws.send(json);
      }
    });
  }

  sendToPlayer(playerId: string, gameId: number, message: any): void {
    const connectionId = `${gameId}-${playerId}`;
    const conn = this.connections.get(connectionId);

    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(message));
    }
  }

  updateHeartbeat(playerId: string, gameId: number): void {
    const connectionId = `${gameId}-${playerId}`;
    const conn = this.connections.get(connectionId);

    if (conn) {
      conn.lastHeartbeat = Date.now();
      conn.isAlive = true;
    }
  }

  checkDeadConnections(): void {
    const now = Date.now();
    const timeout = 60000; // 60 seconds

    this.connections.forEach((conn, connId) => {
      if (now - conn.lastHeartbeat > timeout) {
        console.log(`[ConnectionManager] ⚠️ Dead connection: ${connId}`);
        conn.ws.terminate();
        this.connections.delete(connId);
      }
    });
  }

  getStats(): { totalConnections: number; activeGames: number } {
    return {
      totalConnections: this.connections.size,
      activeGames: this.gameConnections.size
    };
  }
}

class MessageHandler {
  constructor(
    private gameManager: GameManager,
    private connectionManager: ConnectionManager
  ) { }

  handleMessage(playerId: string, gameId: number, message: any): void {
    switch (message.type) {
      case 'heartbeat':
        this.connectionManager.updateHeartbeat(playerId, gameId);
        this.connectionManager.sendToPlayer(playerId, gameId, { type: 'heartbeat_ack' });
        break;

      case 'mark_ready':
        this.gameManager.markPlayerReady(gameId, playerId);
        this.connectionManager.broadcastToGame(gameId, {
          type: 'player_ready',
          playerId
        });
        break;

      case 'player_update':
        if (message.state) {
          this.gameManager.updatePlayerState(gameId, playerId, message.state);
          this.connectionManager.broadcastToGame(
            gameId,
            {
              type: 'player_update',
              playerId,
              state: message.state
            },
            playerId
          );
        }
        break;

      case 'player_eliminated':
        this.connectionManager.broadcastToGame(gameId, {
          type: 'player_eliminated',
          playerId
        });

        const game = this.gameManager.getGameState(gameId);
        if (game) {
          const alivePlayers = Array.from(game.players.values()).filter(p => p.alive);
          if (alivePlayers.length === 1) {
            this.gameManager.declareWinner(gameId, alivePlayers[0].id);
            this.connectionManager.broadcastToGame(gameId, {
              type: 'winner_declared',
              winnerId: alivePlayers[0].id
            });
          }
        }
        break;

      case 'request_sync':
        const gameState = this.gameManager.getGameState(gameId);
        if (gameState) {
          this.connectionManager.sendToPlayer(playerId, gameId, {
            type: 'sync',
            players: Array.from(gameState.players.values())
          });
        }
        break;

      // ✅ NEW: Handle expected players count from frontend
      case 'set_expected_players':
        if (message.count && typeof message.count === 'number') {
          this.gameManager.setExpectedPlayers(gameId, message.count);
        }
        break;

      default:
        console.log(`[MessageHandler] ⚠️ Unknown message type: ${message.type}`);
    }
  }
}

class BattleManager {
  private battles: Map<string, BattleSession> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  handleConnection(ws: WebSocket, challengeId: string, playerId: string): void {
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
      console.log(`[BattleManager] ⚔️ Created battle: ${challengeId}`);
    }

    battle.players.add(playerId);
    battle.connections.set(playerId, ws);

    console.log(`[BattleManager] 🎯 Player ${playerId.slice(0, 8)} joined battle ${challengeId}`);

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

    this.sendTo(ws, {
      type: 'connected',
      challengeId,
      playerId,
      message: 'Connected to battle'
    });
  }

  private handleBattleMessage(id: string, pid: string, msg: any): void {
    const battle = this.battles.get(id);
    if (!battle) return;

    console.log(`[BattleManager] 📨 ${msg.type} from ${pid.slice(0, 8)}`);

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
        const ws = battle.connections.get(pid);
        if (ws) this.sendTo(ws, { type: 'heartbeat_ack' });
        break;
    }
  }

  private handleMove(id: string, pid: string, move: string, round: number): void {
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

        setTimeout(() => this.cleanup(id), 5000);
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

  private removePlayer(id: string, pid: string): void {
    const battle = this.battles.get(id);
    if (!battle) return;

    battle.players.delete(pid);
    battle.connections.delete(pid);

    console.log(`[BattleManager] 👋 Player ${pid.slice(0, 8)} left battle`);

    this.broadcastToBattle(id, {
      type: 'player_disconnected',
      playerId: pid
    });

    if (battle.players.size === 0) {
      this.cleanup(id);
    }
  }

  private broadcastToBattle(id: string, msg: any, excludePid?: string): void {
    const battle = this.battles.get(id);
    if (!battle) return;

    const json = JSON.stringify(msg);
    battle.connections.forEach((ws, pid) => {
      if (ws.readyState === WebSocket.OPEN && pid !== excludePid) {
        ws.send(json);
      }
    });
  }

  private sendTo(ws: WebSocket, msg: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private cleanup(id: string): void {
    const battle = this.battles.get(id);
    if (!battle) return;

    battle.connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    this.battles.delete(id);
    console.log(`[BattleManager] 🗑️ Cleaned up battle: ${id}`);
  }

  startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const timeout = 300000; // 5 minutes

      this.battles.forEach((battle, id) => {
        if (now - battle.createdAt > timeout && battle.status !== 'in_progress') {
          console.log(`[BattleManager] 🧹 Cleaning stale battle: ${id}`);
          this.cleanup(id);
        }
      });
    }, 60000); // Check every minute
  }

  getStats(): { activeBattles: number } {
    return {
      activeBattles: this.battles.size
    };
  }
}

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

    const server = createServer((req, res) => {
      if (req.url === '/health') {
        const stats = {
          status: 'healthy',
          uptime: process.uptime(),
          connections: this.connectionManager.getStats(),
          battles: this.battleManager.getStats(),
          memory: process.memoryUsage()
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Solana Survivor WebSocket Server');
      }
    });

    this.wss = new WebSocketServer({ server });

    this.gameManager.setGameStateChangeCallback((gameId) => {
      this.broadcastGameState(gameId);
    });

    this.setupWebSocketServer();
    this.startHealthCheck();
    this.battleManager.startCleanupTimer();
    this.startStatsLogger();

    server.listen(port, () => {
      console.log('='.repeat(60));
      console.log('🚀 Solana Survivor WebSocket Server');
      console.log('='.repeat(60));
      console.log(`📡 Port: ${port}`);
      console.log(`🎮 Phase 3: ws://localhost:${port}?gameId=X&playerId=Y`);
      console.log(`⚔️  Battles: ws://localhost:${port}/battle?challengeId=X&playerId=Y`);
      console.log(`❤️  Health: http://localhost:${port}/health`);
      console.log('='.repeat(60));
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

    this.wss.on('error', (error) => {
      console.error('[Server] ❌ WebSocket server error:', error);
    });
  }

  private handleBattleConnection(ws: WebSocket, query: any): void {
    const challengeId = query.challengeId as string;
    const playerId = query.playerId as string;

    if (!challengeId || !playerId) {
      console.error('[Server] ❌ Battle - Missing parameters');
      ws.close(1008, 'Invalid parameters');
      return;
    }

    console.log(`[Server] ⚔️ Battle connection: ${playerId.slice(0, 8)} → ${challengeId}`);
    this.battleManager.handleConnection(ws, challengeId, playerId);
  }

  private handlePhase3Connection(ws: WebSocket, query: any): void {
    const gameId = parseInt(query.gameId as string);
    const playerId = query.playerId as string;

    if (!gameId || !playerId || isNaN(gameId)) {
      console.error('[Server] ❌ Phase 3 - Invalid parameters');
      ws.close(1008, 'Invalid parameters');
      return;
    }

    console.log(`[Server] 🎮 Phase 3 connection: ${playerId.slice(0, 8)} → Game ${gameId}`);

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
        this.handlePhase3Message(playerId, gameId, message);
      } catch (error) {
        console.error('[Server] ❌ Parse error:', error);
      }
    });

    ws.on('close', () => {
      console.log(`[Server] 👋 Disconnect: ${playerId.slice(0, 8)} from game ${gameId}`);

      this.connectionManager.removeConnection(playerId, gameId);
      this.gameManager.removePlayer(gameId, playerId);

      this.connectionManager.broadcastToGame(gameId, {
        type: 'player_disconnected',
        playerId
      });
    });

    ws.on('error', (error) => {
      console.error(`[Server] ❌ WebSocket error for ${playerId.slice(0, 8)}:`, error);
    });
  }

  private handlePhase3Message(playerId: string, gameId: number, message: any): void {
    if (message.type === 'set_deadline') {
      this.startDeadlineMonitor(gameId, message.deadline);
    } else {
      this.messageHandler.handleMessage(playerId, gameId, message);

      // ✅ FIX: Only check auto-start after ready, NOT on every message
      if (message.type === 'mark_ready') {
        this.checkAutoStart(gameId);
      }
    }
  }

  // ✅ FIX: checkAutoStart now properly handles race conditions
  private checkAutoStart(gameId: number): void {
    const game = this.gameManager.getGameState(gameId);

    // ✅ Prevent multiple calls
    if (!game || game.hasStarted) {
      return;
    }

    const { canStart, readyCount, reason } = this.gameManager.canStartGame(gameId);

    if (!canStart) {
      console.log(`[Server] ⏸️ Not starting game ${gameId}: ${reason}`);
      return;
    }

    console.log(`[Server] 🚀 Auto-starting game ${gameId} (${readyCount}/${game.expectedPlayers} ready)`);

    // ✅ Add slight delay to ensure all clients are synced
    setTimeout(() => {
      const result = this.gameManager.startGame(gameId);
      if (result.success) {
        this.broadcastGameState(gameId);
      } else {
        console.log(`[Server] ⚠️ Failed to start game ${gameId}: ${result.message}`);
      }
    }, 1000);
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

    console.log(`[Server] ⏰ Deadline set for game ${gameId}: ${Math.round(timeUntilDeadline / 1000)}s`);

    const timer = setTimeout(() => {
      console.log(`[Server] ⏰ Deadline expired for game ${gameId}`);
      this.checkAutoStart(gameId);
    }, timeUntilDeadline);

    this.gameDeadlineTimers.set(gameId, timer);
  }

  private sendInitialGameState(ws: WebSocket, gameId: number): void {
    const game = this.gameManager.getGameState(gameId);
    if (!game) return;

    const stateMessage = {
      type: 'game_state_update',
      phase: game.phase,
      players: Array.from(game.players.values()),
      readyPlayers: Array.from(game.readyPlayers),
      countdownStartTime: game.countdownStartTime,
      countdownDuration: game.countdownDuration
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(stateMessage));
    }
  }

  private broadcastGameState(gameId: number): void {
    const game = this.gameManager.getGameState(gameId);
    if (!game) return;

    const stateMessage = {
      type: 'game_phase_change',
      phase: game.phase,
      countdownStartTime: game.countdownStartTime,
      countdownDuration: game.countdownDuration
    };

    this.connectionManager.broadcastToGame(gameId, stateMessage);

    if (game.phase === 'countdown') {
      this.connectionManager.broadcastToGame(gameId, {
        type: 'countdown_sync',
        startTime: game.countdownStartTime,
        duration: game.countdownDuration
      });
    }

    if (game.phase === 'active') {
      this.connectionManager.broadcastToGame(gameId, {
        type: 'game_start'
      });
    }

    if (game.phase === 'ended' && game.winner) {
      this.connectionManager.broadcastToGame(gameId, {
        type: 'winner_declared',
        winnerId: game.winner
      });
    }
  }

  private startHealthCheck(): void {
    setInterval(() => {
      this.connectionManager.checkDeadConnections();
    }, 30000); // Every 30 seconds
  }

  private startStatsLogger(): void {
    setInterval(() => {
      const connStats = this.connectionManager.getStats();
      const battleStats = this.battleManager.getStats();
      console.log(`📊 Stats - Connections: ${connStats.totalConnections}, Games: ${connStats.activeGames}, Battles: ${battleStats.activeBattles}`);
    }, 60000); // Every minute
  }
}

// ============================================================================
// START SERVER
// ============================================================================

const PORT = parseInt(process.env.PORT || '3001');
new UnifiedServer(PORT);