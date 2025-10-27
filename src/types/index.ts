// src/types/index.ts - Complete Type System

export interface Vector2D {
    x: number;
    y: number;
}

export interface PlayerState {
    id: string;
    walletAddress: string;
    username?: string;
    
    // Position & Movement
    x: number;
    y: number;
    velocityX: number;
    velocityY: number;
    rotation: number;
    
    // Game State
    hp: number;
    maxHp: number;
    vsolBalance: number;
    score: number;
    kills: number;
    
    // Status
    ready: boolean;
    eliminated: boolean;
    isAlive: boolean;
    isInSafeZone: boolean;
    
    // Timestamps
    joinedAt: number;
    lastUpdate: number;
    eliminatedAt?: number;
}

export type GamePhase = 'waiting' | 'countdown' | 'active' | 'ended';

export interface GameConfig {
    gameId: string;
    maxPlayers: number;
    minPlayers: number;
    waitingDuration: number;        // 30 minutes in ms
    countdownDuration: number;      // 10 seconds
    gameDuration: number;           // Max game time
    
    // Map settings
    mapWidth: number;
    mapHeight: number;
    
    // Safe zone
    initialSafeZoneRadius: number;
    minSafeZoneRadius: number;
    safeZoneShrinkInterval: number; // Time between shrinks
    safeZoneDamagePerSecond: number;
    
    // Player settings
    playerRadius: number;
    playerSpeed: number;
    playerMaxHp: number;
    pushForce: number;
    
    // Collision
    enableCollision: boolean;
    collisionDamping: number;
}

export interface SafeZoneState {
    centerX: number;
    centerY: number;
    radius: number;
    targetRadius: number;
    shrinking: boolean;
    nextShrinkAt: number;
}

export interface GameRoomState {
    gameId: string;
    phase: GamePhase;
    players: Map<string, PlayerState>;
    safeZone: SafeZoneState;
    
    // Timing
    createdAt: number;
    waitingEndsAt: number;
    countdownStartedAt?: number;
    gameStartedAt?: number;
    gameEndedAt?: number;
    
    // Stats
    totalPlayers: number;
    readyPlayers: number;
    alivePlayers: number;
    
    winner?: string;
}

export interface WSMessage {
    type: WSMessageType;
    timestamp?: number;
    [key: string]: any;
}

export type WSMessageType =
    // Connection
    | 'ping'
    | 'pong'
    | 'connect'
    | 'disconnect'
    
    // Sync
    | 'sync'
    | 'request_sync'
    
    // Player actions
    | 'player:update'
    | 'player:ready'
    | 'player:connected'
    | 'player:disconnected'
    | 'player:eliminated'
    
    // Game flow
    | 'game:phase'
    | 'game:countdown'
    | 'game:start'
    | 'game:end'
    | 'game:winner'
    
    // Safe zone
    | 'safezone:update'
    | 'safezone:shrink'
    
    // Errors
    | 'error';

export interface PlayerUpdateMessage extends WSMessage {
    type: 'player:update';
    state: Partial<PlayerState>;
}

export interface SyncMessage extends WSMessage {
    type: 'sync';
    players: PlayerState[];
    safeZone: SafeZoneState;
    phase: GamePhase;
    countdown?: number;
}

export interface GamePhaseMessage extends WSMessage {
    type: 'game:phase';
    phase: GamePhase;
}

export interface CountdownMessage extends WSMessage {
    type: 'game:countdown';
    startTime: number;
    duration: number;
}

export interface WinnerMessage extends WSMessage {
    type: 'game:winner';
    winnerId: string;
    playerAddress: string;
    finalStats: {
        kills: number;
        survivedTime: number;
        finalPosition: Vector2D;
    };
}

export interface SafeZoneUpdateMessage extends WSMessage {
    type: 'safezone:update';
    safeZone: SafeZoneState;
}

export interface ErrorMessage extends WSMessage {
    type: 'error';
    message: string;
    code?: string;
}

// Statistics & Monitoring
export interface ServerStats {
    uptime: number;
    totalGames: number;
    activeGames: number;
    totalPlayers: number;
    messagesPerSecond: number;
    memoryUsage: number;
}

export interface GameStats {
    gameId: string;
    phase: GamePhase;
    duration: number;
    totalPlayers: number;
    alivePlayers: number;
    readyPlayers: number;
    safeZoneRadius: number;
    averageLatency: number;
}
