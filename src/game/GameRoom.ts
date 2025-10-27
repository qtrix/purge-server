// src/game/GameRoom.ts - Complete Game Room Management

import { Player } from './Player';
import { SafeZone } from './SafeZone';
import { CollisionSystem } from './CollisionSystem';
import {
    GameConfig,
    GamePhase,
    PlayerState,
    SafeZoneState,
    Vector2D,
    WSMessage
} from '../types';
import { Vec2 } from '../utils/Vector2D';
import { logger } from '../utils/Logger';
import WebSocket from 'ws';

export class GameRoom {
    private gameId: string;
    private config: GameConfig;
    private phase: GamePhase;

    private players: Map<string, Player>;
    private connections: Map<string, WebSocket>;

    private safeZone: SafeZone;
    private collisionSystem: CollisionSystem;

    // Timing
    private createdAt: number;
    private waitingEndsAt: number;
    private countdownStartedAt?: number;
    private gameStartedAt?: number;
    private gameEndedAt?: number;

    // Game loop
    private gameLoopInterval?: NodeJS.Timeout;
    private readonly TICK_RATE = 60; // 60 ticks per second
    private lastTickTime: number;

    private winner?: string;
    private log: ReturnType<typeof logger.child>;

    constructor(gameId: string, config: GameConfig) {
        this.gameId = gameId;
        this.config = config;
        this.phase = 'waiting';

        this.players = new Map();
        this.connections = new Map();

        this.createdAt = Date.now();
        this.waitingEndsAt = this.createdAt + config.waitingDuration;
        this.lastTickTime = Date.now();

        // Initialize systems
        this.safeZone = new SafeZone(
            config.mapWidth,
            config.mapHeight,
            config.initialSafeZoneRadius,
            config.minSafeZoneRadius,
            config.safeZoneShrinkInterval,
            config.safeZoneDamagePerSecond
        );

        this.collisionSystem = new CollisionSystem({
            playerRadius: config.playerRadius,
            pushForce: config.pushForce,
            damping: config.collisionDamping,
            enabled: config.enableCollision
        });

        this.log = logger.child(`Game-${gameId}`);
        this.log.info('GameRoom created', {
            maxPlayers: config.maxPlayers,
            waitingDuration: config.waitingDuration / 1000 + 's'
        });
    }

    // ==================== Player Management ====================

    /**
     * Add player to game room (with reconnection support)
     */
    addPlayer(playerId: string, walletAddress: string, vsolBalance: number, ws: WebSocket): boolean {
        // Check if player already exists (reconnection scenario)
        if (this.players.has(playerId)) {
            const existingPlayer = this.players.get(playerId)!;

            // Allow reconnection if player is still alive or game is in waiting/countdown
            if (this.phase === 'waiting' || this.phase === 'countdown' || existingPlayer.isAlive()) {
                this.log.info('Player reconnecting', {
                    playerId: playerId.slice(0, 8),
                    phase: this.phase,
                    alive: existingPlayer.isAlive()
                });

                // Update connection
                this.connections.set(playerId, ws);

                // Send full sync to reconnected player
                this.sendSync(playerId);

                // Notify others of reconnection
                this.broadcast({
                    type: 'player:connected',
                    playerId,
                    state: existingPlayer.toJSON()
                }, playerId);

                return true;
            } else {
                this.log.warn('Player already exists and is eliminated', { playerId });
                return false;
            }
        }

        if (this.players.size >= this.config.maxPlayers) {
            this.log.warn('Game is full', { playerId });
            return false;
        }

        if (this.phase !== 'waiting' && this.phase !== 'countdown') {
            this.log.warn('Game already started', { playerId });
            return false;
        }

        // Spawn player at random position in safe zone
        const spawnPos = Vec2.randomPointInCircle(
            this.safeZone.getCenter(),
            this.safeZone.getRadius() * 0.8
        );

        const player = new Player(playerId, walletAddress, spawnPos, vsolBalance);
        this.players.set(playerId, player);
        this.connections.set(playerId, ws);

        this.log.info('Player joined', {
            playerId: playerId.slice(0, 8),
            wallet: walletAddress.slice(0, 8),
            position: `(${spawnPos.x.toFixed(0)}, ${spawnPos.y.toFixed(0)})`,
            totalPlayers: this.players.size
        });

        // Notify all players
        this.broadcast({
            type: 'player:connected',
            playerId,
            state: player.toJSON()
        }, playerId);

        // Send full sync to new player
        this.sendSync(playerId);

        return true;
    }

    /**
     * Remove player from game room
     */
    removePlayer(playerId: string): void {
        const player = this.players.get(playerId);
        if (!player) return;

        this.players.delete(playerId);
        this.connections.delete(playerId);

        this.log.info('Player left', {
            playerId: playerId.slice(0, 8),
            totalPlayers: this.players.size
        });

        // Notify others
        this.broadcast({
            type: 'player:disconnected',
            playerId
        });

        // Check if game should end
        if (this.phase === 'active') {
            this.checkWinCondition();
        }
    }

    /**
     * Mark player as ready
     */
    markPlayerReady(playerId: string): void {
        const player = this.players.get(playerId);
        if (!player) return;

        player.setReady(true);

        this.log.info('Player ready', {
            playerId: playerId.slice(0, 8),
            readyCount: this.getReadyCount()
        });

        this.broadcast({
            type: 'player:ready',
            playerId
        });

        // Check if we can start countdown
        this.checkCountdownStart();
    }

    /**
     * Update player state from client
     */
    updatePlayer(playerId: string, update: Partial<PlayerState>): void {
        const player = this.players.get(playerId);
        if (!player || !player.isAlive()) return;

        player.updateFromClient(update);

        // Clamp to map bounds
        player.clampPosition(this.config.mapWidth, this.config.mapHeight, this.config.playerRadius);

        // Broadcast to others (batched in game loop)
    }

    // ==================== Game Flow ====================

    /**
     * Check if countdown should start
     */
    private checkCountdownStart(): void {
        if (this.phase !== 'waiting') return;

        const readyCount = this.getReadyCount();
        const totalCount = this.players.size;

        // Start countdown if 2+ players ready
        if (readyCount >= 2 && readyCount >= this.config.minPlayers) {
            this.startCountdown();
        }
    }

    /**
     * Start countdown phase
     */
    private startCountdown(): void {
        if (this.phase !== 'waiting') return;

        this.phase = 'countdown';
        this.countdownStartedAt = Date.now();

        this.log.info('Countdown started', {
            readyPlayers: this.getReadyCount(),
            totalPlayers: this.players.size
        });

        this.broadcast({
            type: 'game:countdown',
            startTime: this.countdownStartedAt,
            duration: this.config.countdownDuration
        });

        // Start game after countdown
        setTimeout(() => {
            this.startGame();
        }, this.config.countdownDuration);
    }

    /**
     * Start active game
     */
    private startGame(): void {
        const readyCount = this.getReadyCount();

        // Check if only 1 player ready
        if (readyCount === 1) {
            const winner = Array.from(this.players.values()).find(p => p.isReady());
            if (winner) {
                this.log.info('Only 1 player ready - instant win');
                this.endGame(winner.getId());
                return;
            }
        }

        this.phase = 'active';
        this.gameStartedAt = Date.now();

        this.log.info('Game started', {
            activePlayers: readyCount
        });

        // Eliminate players who didn't ready up
        this.players.forEach(player => {
            if (!player.isReady()) {
                player.eliminate();
                this.broadcast({
                    type: 'player:eliminated',
                    playerId: player.getId(),
                    reason: 'not_ready'
                });
            }
        });

        this.broadcast({
            type: 'game:start'
        });

        // Start game loop
        this.startGameLoop();
    }

    /**
     * Start game loop (60 ticks/sec)
     */
    private startGameLoop(): void {
        const tickInterval = 1000 / this.TICK_RATE;

        this.gameLoopInterval = setInterval(() => {
            const now = Date.now();
            const deltaTime = now - this.lastTickTime;
            this.lastTickTime = now;

            this.tick(deltaTime);
        }, tickInterval);

        this.log.info('Game loop started', { tickRate: this.TICK_RATE });
    }

    /**
     * Main game tick
     */
    private tick(deltaTime: number): void {
        if (this.phase !== 'active') return;

        // 1. Update safe zone
        const safeZoneChanged = this.safeZone.update(deltaTime);
        if (safeZoneChanged) {
            this.broadcast({
                type: 'safezone:update',
                safeZone: this.safeZone.getState()
            });
        }

        // 2. Check players vs safe zone
        this.checkSafeZoneDamage(deltaTime);

        // 3. Check collisions
        this.collisionSystem.checkCollisions(Array.from(this.players.values()));

        // 4. Apply physics (damping, movement)
        this.players.forEach(player => {
            if (player.isAlive()) {
                this.collisionSystem.applyDamping(player, deltaTime);
            }
        });

        // 5. Check win condition
        this.checkWinCondition();

        // 6. Broadcast player updates (throttled)
        this.broadcastPlayerUpdates();
    }

    /**
     * Check safe zone damage
     */
    private checkSafeZoneDamage(deltaTime: number): void {
        this.players.forEach(player => {
            if (!player.isAlive()) return;

            const isInSafeZone = this.safeZone.isInside(player.getPosition());
            player.updateSafeZoneStatus(isInSafeZone);

            if (!isInSafeZone) {
                const damage = this.safeZone.calculateDamage(deltaTime);
                if (damage > 0) {
                    const died = player.takeDamage(damage);

                    if (died) {
                        this.log.info('Player eliminated by safe zone', {
                            playerId: player.getId().slice(0, 8)
                        });

                        this.broadcast({
                            type: 'player:eliminated',
                            playerId: player.getId(),
                            reason: 'safezone'
                        });
                    }
                }
            }
        });
    }

    /**
     * Check if game should end
     */
    private checkWinCondition(): void {
        const alivePlayers = Array.from(this.players.values()).filter(p => p.isAlive());

        if (alivePlayers.length === 1) {
            this.endGame(alivePlayers[0].getId());
        } else if (alivePlayers.length === 0) {
            // Draw - shouldn't happen but handle it
            this.endGame();
        }
    }

    /**
     * End game
     */
    private endGame(winnerId?: string): void {
        if (this.phase === 'ended') return;

        this.phase = 'ended';
        this.gameEndedAt = Date.now();
        this.winner = winnerId;

        if (this.gameLoopInterval) {
            clearInterval(this.gameLoopInterval);
            this.gameLoopInterval = undefined;
        }

        const winner = winnerId ? this.players.get(winnerId) : null;

        this.log.info('Game ended', {
            winner: winner ? winner.getWalletAddress().slice(0, 8) : 'none',
            duration: this.gameEndedAt - (this.gameStartedAt || this.createdAt)
        });

        this.broadcast({
            type: 'game:winner',
            winnerId: winnerId || '',
            playerAddress: winner?.getWalletAddress() || '',
            finalStats: winner ? {
                kills: winner.getState().kills,
                survivedTime: winner.getSurvivalTime(),
                finalPosition: winner.getPosition()
            } : undefined
        });
    }

    // ==================== Broadcasting ====================

    /**
     * Send full sync to specific player
     */
    private sendSync(playerId: string): void {
        const ws = this.connections.get(playerId);
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const playersArray = Array.from(this.players.values()).map(p => p.toJSON());

        this.send(ws, {
            type: 'sync',
            players: playersArray,
            safeZone: this.safeZone.getState(),
            phase: this.phase,
            countdown: this.getCountdownRemaining()
        });
    }

    /**
     * Broadcast player state updates (throttled)
     */
    private lastBroadcastTime = 0;
    private broadcastPlayerUpdates(): void {
        const now = Date.now();
        if (now - this.lastBroadcastTime < 50) return; // 20 updates/sec

        this.lastBroadcastTime = now;

        this.players.forEach((player, playerId) => {
            if (player.isAlive()) {
                this.broadcast({
                    type: 'player:update',
                    id: playerId,
                    state: player.toJSON()
                }, playerId);
            }
        });
    }

    /**
     * Broadcast message to all players
     */
    private broadcast(message: WSMessage, excludePlayerId?: string): void {
        this.connections.forEach((ws, playerId) => {
            if (playerId === excludePlayerId) return;
            this.send(ws, message);
        });
    }

    /**
     * Send message to specific connection
     */
    private send(ws: WebSocket, message: WSMessage): void {
        if (ws.readyState !== WebSocket.OPEN) return;

        try {
            ws.send(JSON.stringify({
                ...message,
                timestamp: Date.now()
            }));
        } catch (error) {
            this.log.error('Failed to send message', { error });
        }
    }

    // ==================== Getters ====================

    getGameId(): string {
        return this.gameId;
    }

    getPhase(): GamePhase {
        return this.phase;
    }

    getPlayerCount(): number {
        return this.players.size;
    }

    getReadyCount(): number {
        return Array.from(this.players.values()).filter(p => p.isReady()).length;
    }

    getAliveCount(): number {
        return Array.from(this.players.values()).filter(p => p.isAlive()).length;
    }

    getCountdownRemaining(): number | null {
        if (!this.countdownStartedAt) return null;

        const elapsed = Date.now() - this.countdownStartedAt;
        const remaining = this.config.countdownDuration - elapsed;

        return Math.max(0, Math.ceil(remaining / 1000));
    }

    getWaitingTimeRemaining(): number {
        return Math.max(0, this.waitingEndsAt - Date.now());
    }

    hasPlayer(playerId: string): boolean {
        return this.players.has(playerId);
    }

    canJoin(): boolean {
        return (this.phase === 'waiting' || this.phase === 'countdown') &&
            this.players.size < this.config.maxPlayers;
    }

    /**
     * Check if game is expired (waiting timeout)
     */
    isExpired(): boolean {
        if (this.phase === 'waiting' && Date.now() > this.waitingEndsAt) {
            // Check ready count
            const readyCount = this.getReadyCount();
            if (readyCount === 1) {
                return true; // Will be handled to end with 1 winner
            }
        }
        return false;
    }

    /**
     * Cleanup game room
     */
    cleanup(): void {
        if (this.gameLoopInterval) {
            clearInterval(this.gameLoopInterval);
        }

        this.connections.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        });

        this.players.clear();
        this.connections.clear();

        this.log.info('GameRoom cleaned up');
    }
}
