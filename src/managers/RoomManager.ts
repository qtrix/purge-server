// src/managers/RoomManager.ts - Multi-Room Management

import { GameRoom } from '../game/GameRoom';
import { GameConfig } from '../types';
import { logger } from '../utils/Logger';
import WebSocket from 'ws';

export class RoomManager {
    private rooms: Map<string, GameRoom>;
    private defaultConfig: GameConfig;
    private log: ReturnType<typeof logger.child>;

    constructor() {
        this.rooms = new Map();
        this.log = logger.child('RoomManager');

        // Default configuration
        this.defaultConfig = {
            gameId: '',
            maxPlayers: 100,
            minPlayers: 2,
            waitingDuration: 30 * 60 * 1000,  // 30 minutes
            countdownDuration: 10 * 1000,      // 10 seconds
            gameDuration: 60 * 60 * 1000,      // 60 minutes max

            mapWidth: 2000,
            mapHeight: 2000,

            initialSafeZoneRadius: 900,
            minSafeZoneRadius: 100,
            safeZoneShrinkInterval: 60 * 1000, // Shrink every 60 seconds
            safeZoneDamagePerSecond: 5,

            playerRadius: 20,
            playerSpeed: 200,
            playerMaxHp: 100,
            pushForce: 100,

            enableCollision: true,
            collisionDamping: 0.95
        };

        this.log.info('RoomManager initialized', {
            defaultMaxPlayers: this.defaultConfig.maxPlayers,
            waitingDuration: this.defaultConfig.waitingDuration / 1000 + 's'
        });

        // Start cleanup interval
        this.startCleanupInterval();
    }

    /**
     * Create or get game room
     */
    getOrCreateRoom(gameId: string, config?: Partial<GameConfig>): GameRoom {
        let room = this.rooms.get(gameId);

        if (!room) {
            const fullConfig = {
                ...this.defaultConfig,
                ...config,
                gameId
            };

            room = new GameRoom(gameId, fullConfig);
            this.rooms.set(gameId, room);

            this.log.info('Room created', {
                gameId,
                totalRooms: this.rooms.size
            });
        }

        return room;
    }

    /**
     * Get existing room
     */
    getRoom(gameId: string): GameRoom | undefined {
        return this.rooms.get(gameId);
    }

    /**
     * Add player to room
     */
    addPlayerToRoom(
        gameId: string,
        playerId: string,
        walletAddress: string,
        vsolBalance: number,
        ws: WebSocket
    ): { success: boolean; error?: string } {
        const room = this.getOrCreateRoom(gameId);

        if (!room.canJoin()) {
            return {
                success: false,
                error: 'Game has already started or is full'
            };
        }

        const added = room.addPlayer(playerId, walletAddress, vsolBalance, ws);

        if (!added) {
            return {
                success: false,
                error: 'Failed to add player to room'
            };
        }

        return { success: true };
    }

    /**
     * Remove player from room
     */
    removePlayerFromRoom(gameId: string, playerId: string): void {
        const room = this.rooms.get(gameId);
        if (!room) return;

        room.removePlayer(playerId);

        // Cleanup empty rooms in waiting phase
        if (room.getPlayerCount() === 0 && room.getPhase() === 'waiting') {
            this.deleteRoom(gameId);
        }
    }

    /**
     * Delete room
     */
    deleteRoom(gameId: string): void {
        const room = this.rooms.get(gameId);
        if (!room) return;

        room.cleanup();
        this.rooms.delete(gameId);

        this.log.info('Room deleted', {
            gameId,
            totalRooms: this.rooms.size
        });
    }

    /**
     * Get all active rooms
     */
    getActiveRooms(): GameRoom[] {
        return Array.from(this.rooms.values());
    }

    /**
     * Get room stats
     */
    getRoomStats(gameId: string) {
        const room = this.rooms.get(gameId);
        if (!room) return null;

        return {
            gameId,
            phase: room.getPhase(),
            playerCount: room.getPlayerCount(),
            readyCount: room.getReadyCount(),
            aliveCount: room.getAliveCount(),
            canJoin: room.canJoin(),
            countdownRemaining: room.getCountdownRemaining(),
            waitingTimeRemaining: room.getWaitingTimeRemaining()
        };
    }

    /**
     * Get all rooms stats
     */
    getAllStats() {
        const rooms = Array.from(this.rooms.values()).map(room => ({
            gameId: room.getGameId(),
            phase: room.getPhase(),
            players: room.getPlayerCount(),
            ready: room.getReadyCount(),
            alive: room.getAliveCount()
        }));

        return {
            totalRooms: this.rooms.size,
            totalPlayers: rooms.reduce((sum, r) => sum + r.players, 0),
            rooms
        };
    }

    /**
     * Cleanup expired rooms
     */
    private startCleanupInterval(): void {
        setInterval(() => {
            this.cleanupExpiredRooms();
        }, 60 * 1000); // Check every minute
    }

    private cleanupExpiredRooms(): void {
        const now = Date.now();
        const toDelete: string[] = [];

        this.rooms.forEach((room, gameId) => {
            // Delete ended games after 5 minutes
            if (room.getPhase() === 'ended') {
                toDelete.push(gameId);
            }

            // Delete expired waiting rooms
            if (room.isExpired()) {
                // Handle timeout - if 1 player ready, they win
                const readyCount = room.getReadyCount();
                if (readyCount === 1) {
                    this.log.info('Waiting timeout - 1 player wins', { gameId });
                    // GameRoom will handle this internally
                } else {
                    this.log.info('Waiting timeout - no players ready', { gameId });
                    toDelete.push(gameId);
                }
            }
        });

        toDelete.forEach(gameId => {
            this.deleteRoom(gameId);
        });

        if (toDelete.length > 0) {
            this.log.info('Cleanup completed', {
                deletedRooms: toDelete.length,
                remainingRooms: this.rooms.size
            });
        }
    }

    /**
     * Shutdown all rooms
     */
    shutdown(): void {
        this.log.info('Shutting down all rooms', {
            totalRooms: this.rooms.size
        });

        this.rooms.forEach((room, gameId) => {
            room.cleanup();
        });

        this.rooms.clear();
    }
}
