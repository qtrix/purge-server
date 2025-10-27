// src/types/index.ts - Type Definitions (UPDATED with new message types)

import WebSocket from 'ws';

// ==================== Vector & Position ====================

export interface Vector2D {
    x: number;
    y: number;
}

export interface Position extends Vector2D {}

// ==================== Game Configuration ====================

export interface GameConfig {
    // Room settings
    maxPlayers: number;
    minPlayers: number;
    
    // Timing
    waitingDuration: number;           // 30 minutes default
    countdownDuration: number;         // 10 seconds
    
    // Map
    mapWidth: number;
    mapHeight: number;
    
    // Safe Zone
    initialSafeZoneRadius: number;
    minSafeZoneRadius: number;
    safeZoneShrinkInterval: number;    // 60 seconds
    safeZoneDamagePerSecond: number;   // 5 HP/sec
    
    // Player
    maxHp: number;
    playerRadius: number;
    playerSpeed: number;
    
    // Collision
    enableCollision: boolean;
    pushForce: number;
    collisionDamping: number;
}

// ==================== Game Phase ====================

export type GamePhase = 'waiting' | 'countdown' | 'active' | 'ended';

// ==================== Player State ====================

export interface PlayerState {
    id: string;
    walletAddress: string;
    position: Position;
    velocity: Vector2D;
    hp: number;
    maxHp: number;
    radius: number;
    speed: number;
    eliminated: boolean;
    vsolBalance: number;
    ready: boolean;
    color: string;
    lastUpdate: number;
    kills?: number;
}

// ==================== Safe Zone ====================

export interface SafeZoneState {
    center: Position;
    radius: number;
    targetRadius: number;
    shrinking: boolean;
    damagePerSecond: number;
}

// ==================== WebSocket Messages ====================

export type WSMessageType = 
    // Connection
    | 'connected'           // ✅ NEW: Server confirms connection
    | 'join'               // ✅ NEW: Client requests to join with vsolBalance
    | 'joined'             // ✅ NEW: Server confirms player joined
    | 'connect'
    | 'disconnect'
    | 'error'
    | 'ping'
    | 'pong'
    
    // Sync
    | 'sync'
    | 'request_sync'
    
    // Player actions
    | 'player:connected'
    | 'player:disconnected'
    | 'player:update'
    | 'player:ready'
    | 'player:eliminated'
    
    // Game state
    | 'phase:change'
    | 'countdown:update'
    | 'game:start'
    | 'game:winner'
    
    // Safe zone
    | 'safezone:update'
    | 'safezone:shrink';

export interface WSMessage {
    type: WSMessageType;
    timestamp?: number;
    
    // Connection messages
    message?: string;              // For 'connected', 'joined', 'error'
    vsolBalance?: number;          // ✅ NEW: For 'join' message
    
    // Player data
    playerId?: string;
    playerAddress?: string;
    state?: PlayerState;
    
    // Game data
    phase?: GamePhase;
    countdown?: number;
    players?: PlayerState[];
    safeZone?: SafeZoneState;
    
    // Game results
    winnerId?: string;
    finalStats?: {
        kills: number;
        survivedTime: number;
        finalPosition: Position;
    };
    
    // Sync data
    id?: string;
}

// ==================== Room Manager ====================

export interface RoomStats {
    gameId: string;
    phase: GamePhase;
    playerCount: number;
    readyCount: number;
    createdAt: number;
    waitingEndsAt: number;
}

export interface AddPlayerResult {
    success: boolean;
    error?: string;
}

// ==================== Collision System ====================

export interface CollisionConfig {
    playerRadius: number;
    pushForce: number;
    damping: number;
    enabled: boolean;
}

export interface CollisionPair {
    player1Id: string;
    player2Id: string;
    normal: Vector2D;
    penetration: number;
}
