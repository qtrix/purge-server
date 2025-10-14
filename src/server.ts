// backend/src/server.ts - Complete Clean WebSocket Server

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
    }
    return this.games.get(gameId)!;
  }

  addPlayer(gameId: number, playerId: string): void {
    const game = this.getOrCreateGame(gameId);
    if (!game.players.has(playerId)) {
      console.log(`[GM] Player ${playerId.slice(0, 8)} joined game ${gameId}`);
    }
  }

  removePlayer(gameId: number, playerId: string): void {
    const game = this.games.get(gameId);
    if (!game) return;
    game.players.delete(playerId);
    game.readyPlayers.delete(playerId);
    if (game.players.size === 0) {
      this.clearGameTimer(gameId);
      this.games.delete(gameId);
    }
  }

  markPlayerReady(gameId: number, playerId: string): void {
    const game = this.getOrCreateGame(gameId);
    game.readyPlayers.add(playerId);
    if (this.onGameStateChange) {
      this.onGameStateChange(gameId);
    }
  }

  canStartGame(gameId: number): { canStart: boolean; readyCount: number } {
    const game = this.games.get(gameId);
    if (!game) return { canStart: false, readyCount: 0 };
    const readyCount = game.readyPlayers.size;
    return { canStart: readyCount >= 2, readyCount };
  }

  startGame(gameId: number): { success: boolean; message: string; gameState?: GameSession } {
    const game = this.games.get(gameId);
    if (!game) return { success: false, message: 'Game not found' };
    const readyCount = game.readyPlayers.size;
    if (game.phase !== 'waiting') return { success: false, message: `Game in phase: ${game.phase}` };
    if (readyCount === 0) return { success: false, message: 'No players ready' };
    if (readyCount === 1) {
      game.phase = 'ended';
      game.winner = Array.from(game.readyPlayers)[0];
      return { success: true, message: 'Auto-winner', gameState: game };
    }
    game.phase = 'countdown';
    game.countdownStartTime = Date.now();
    const timer = setTimeout(() => {
      const g = this.games.get(gameId);
      if (g) {
        g.phase = 'active';
        g.startTime = Date.now();
        if (this.onGameStateChange) {
          this.onGameStateChange(gameId);
        }
      }
    }, game.countdownDuration);
    this.gameTimers.set(gameId, timer);
    return { success: true, message: 'Countdown started', gameState: game };
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
    }
    battle.players.add(playerId);
    battle.connections.set(playerId, ws);
    this.sendTo(ws, { type: 'player_joined', playerId, playersCount: battle.players.size, challengeId });
    this.broadcastToBattle(challengeId, { type: 'player_joined', playerId, playersCount: battle.players.size }, playerId);
    if (battle.players.size === 2 && battle.status === 'waiting') {
      battle.status = 'ready';
      this.broadcastToBattle(challengeId, { type: 'game_ready', challengeId, players: Array.from(battle.players) });
      setTimeout(() => {
        const b = this.battles.get(challengeId);
        if (b) b.status = 'in_progress';
      }, 1000);
    }
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(challengeId, playerId, msg);
      } catch (e) { }
    });
    ws.on('close', () => this.handleDisconnect(challengeId, playerId));
  }

  private handleMessage(challengeId: string, playerId: string, msg: any) {
    const battle = this.battles.get(challengeId);
    if (!battle) return;
    if (msg.type === 'submit_move') {
      const round = msg.round;
      const move: BattleMove = { playerId, move: msg.move, round, submittedAt: Date.now() };
      if (!battle.moves.has(round)) battle.moves.set(round, []);
      const roundMoves = battle.moves.get(round)!;
      if (roundMoves.some(m => m.playerId === playerId)) return;
      roundMoves.push(move);
      this.broadcastToBattle(challengeId, { type: 'opponent_moved', playerId }, playerId);
      if (roundMoves.length === 2) {
        this.broadcastToBattle(challengeId, {
          type: 'round_complete',
          round,
          moves: roundMoves.map(m => ({ playerAddress: m.playerId, move: m.move }))
        });
      }
    } else if (msg.type === 'game_ended') {
      battle.status = 'ended';
      battle.winner = msg.winner;
      this.broadcastToBattle(challengeId, { type: 'game_ended', winner: msg.winner, challengeId });
      setTimeout(() => this.cleanup(challengeId), 30000);
    }
  }

  private handleDisconnect(challengeId: string, playerId: string) {
    const battle = this.battles.get(challengeId);
    if (!battle) return;
    battle.connections.delete(playerId);
    this.broadcastToBattle(challengeId, { type: 'opponent_left', playerId }, playerId);
    if (battle.status === 'in_progress') {
      const remaining = Array.from(battle.players).find(p => p !== playerId);
      if (remaining) {
        battle.winner = remaining;
        this.broadcastToBattle(challengeId, { type: 'game_ended', winner: remaining, challengeId });
      }
    }
    if (battle.connections.size === 0) this.cleanup(challengeId);
  }

  private sendTo(ws: WebSocket, msg: any) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcastToBattle(id: string, msg: any, exclude?: string) {
    const battle = this.battles.get(id);
    if (!battle) return;
    battle.connections.forEach((ws, pid) => {
      if (pid !== exclude) this.sendTo(ws, msg);
    });
  }

  private cleanup(id: string) {
    const battle = this.battles.get(id);
    if (!battle) return;
    battle.connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });
    this.battles.delete(id);
  }

  startCleanupTimer() {
    setInterval(() => {
      const now = Date.now();
      this.battles.forEach((b, id) => {
        if (now - b.createdAt > 1800000 && b.status !== 'in_progress') this.cleanup(id);
      });
    }, 60000);
  }
}

class UnifiedServer {
  private wss: WebSocketServer;
  private gameManager = new GameManager();
  private battleManager = new BattleManager();
  private connections: Map<string, WebSocket> = new Map();
  private gameDeadlineTimers: Map<number, NodeJS.Timeout> = new Map();

  constructor(port: number = 3001) {
    const server = createServer();
    this.wss = new WebSocketServer({ server });
    this.gameManager.setGameStateChangeCallback((gameId) => this.broadcastGameState(gameId));
    this.wss.on('connection', (ws, req) => {
      const { pathname, query } = parse(req.url || '', true);
      if (pathname === '/battle') {
        const challengeId = query.challengeId as string;
        const playerId = query.playerId as string;
        if (!challengeId || !playerId) {
          ws.close(1008, 'Invalid params');
          return;
        }
        this.battleManager.handleConnection(ws, challengeId, playerId);
      } else {
        const gameId = parseInt(query.gameId as string);
        const playerId = query.playerId as string;
        if (!gameId || !playerId) {
          ws.close(1008, 'Invalid params');
          return;
        }
        this.handlePhase3(ws, gameId, playerId);
      }
    });
    this.battleManager.startCleanupTimer();
    server.listen(port, () => console.log(`[Server] Running on port ${port}`));
  }

  private handlePhase3(ws: WebSocket, gameId: number, playerId: string) {
    const connId = `${gameId}-${playerId}`;
    this.connections.set(connId, ws);
    this.gameManager.addPlayer(gameId, playerId);
    const game = this.gameManager.getGameState(gameId);
    if (game) {
      this.sendTo(ws, {
        type: 'game_state_update',
        gameState: {
          phase: game.phase,
          countdownStartTime: game.countdownStartTime,
          countdownDuration: game.countdownDuration,
          readyPlayers: game.readyPlayers.size,
          totalPlayers: game.players.size
        }
      });
    }
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handlePhase3Message(gameId, playerId, msg);
      } catch (e) { }
    });
    ws.on('close', () => {
      this.connections.delete(connId);
      this.gameManager.removePlayer(gameId, playerId);
    });
  }

  private handlePhase3Message(gameId: number, playerId: string, msg: any) {
    if (msg.type === 'mark_ready') {
      this.gameManager.markPlayerReady(gameId, playerId);
      this.broadcastGameState(gameId);
      this.checkAutoStart(gameId);
    } else if (msg.type === 'start_game') {
      const result = this.gameManager.startGame(gameId);
      if (result.success) this.broadcastGameState(gameId);
    } else if (msg.type === 'set_deadline') {
      this.startDeadlineMonitor(gameId, msg.deadline);
    }
  }

  private checkAutoStart(gameId: number): void {
    const { canStart, readyCount } = this.gameManager.canStartGame(gameId);
    if (canStart) {
      setTimeout(() => {
        const result = this.gameManager.startGame(gameId);
        if (result.success) this.broadcastGameState(gameId);
      }, 1000);
    }
  }

  private startDeadlineMonitor(gameId: number, deadline: number): void {
    const existingTimer = this.gameDeadlineTimers.get(gameId);
    if (existingTimer) clearTimeout(existingTimer);
    const now = Date.now();
    const timeUntilDeadline = deadline - now;
    if (timeUntilDeadline <= 0) {
      this.checkAutoStart(gameId);
      return;
    }
    const timer = setTimeout(() => this.checkAutoStart(gameId), timeUntilDeadline);
    this.gameDeadlineTimers.set(gameId, timer);
  }

  private broadcastGameState(gameId: number) {
    const game = this.gameManager.getGameState(gameId);
    if (!game) return;
    const msg = {
      type: 'game_state_update',
      gameState: {
        phase: game.phase,
        countdownStartTime: game.countdownStartTime,
        countdownDuration: game.countdownDuration,
        readyPlayers: game.readyPlayers.size,
        totalPlayers: game.players.size
      }
    };
    this.connections.forEach((ws, connId) => {
      if (connId.startsWith(`${gameId}-`)) this.sendTo(ws, msg);
    });
  }

  private sendTo(ws: WebSocket, msg: any) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}

const PORT = parseInt(process.env.PORT || process.env.WS_PORT || '3001');
new UnifiedServer(PORT);