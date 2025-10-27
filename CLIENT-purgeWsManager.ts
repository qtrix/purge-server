// CLIENT: src/lib/purgeWsManager.ts - Updated Client-Side Manager

import { PlayerState } from '@/types/multiplayer';

// Use environment variable or fallback
const WS_URL = import.meta.env.VITE_PURGE_WS_URL || 'ws://localhost:3001';

export type GamePhase = 'waiting' | 'countdown' | 'active' | 'ended';

interface SafeZone {
    centerX: number;
    centerY: number;
    radius: number;
    targetRadius: number;
    shrinking: boolean;
}

interface PurgeCallbacks {
    onConnected?: () => void;
    onDisconnected?: () => void;
    onReconnecting?: (attempt: number) => void;
    onSync?: (players: PlayerState[]) => void;
    onPlayerUpdate?: (id: string, state: Partial<PlayerState>) => void;
    onPlayerJoined?: (id: string, state: PlayerState) => void;
    onPlayerLeft?: (id: string) => void;
    onPlayerEliminated?: (id: string) => void;
    onPlayerReady?: (id: string) => void;
    onGamePhaseChange?: (phase: GamePhase) => void;
    onCountdownStart?: (startTime: number, duration: number) => void;
    onGameStart?: () => void;
    onGameEnd?: (winnerId: string) => void;
    onSafeZoneUpdate?: (safeZone: SafeZone) => void;
    onError?: (error: string) => void;
}

class PurgeWSManager {
    private ws: WebSocket | null = null;
    private gameId: string;
    private playerId: string;
    private callbacks: PurgeCallbacks = {};
    
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private isIntentionalClose = false;

    // Update batching
    private updateQueue: Partial<PlayerState>[] = [];
    private batchInterval: NodeJS.Timeout | null = null;
    private readonly BATCH_INTERVAL = 50; // 20 updates/sec

    // Connection quality monitoring
    private pingTime = 0;
    private latency = 0;
    private messagesSent = 0;
    private messagesReceived = 0;

    constructor(gameId: string, playerId: string) {
        this.gameId = gameId;
        this.playerId = playerId;
    }

    connect(callbacks: PurgeCallbacks): void {
        this.callbacks = callbacks;
        this.isIntentionalClose = false;

        const url = `${WS_URL}/game?gameId=${this.gameId}&playerId=${this.playerId}`;
        console.log('[PurgeWS] Connecting:', url);

        try {
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                console.log('[PurgeWS] ✅ Connected');
                this.reconnectAttempts = 0;
                this.startHeartbeat();
                this.startBatching();
                this.callbacks.onConnected?.();

                // Request initial sync
                this.send({ type: 'request_sync' });
            };

            this.ws.onmessage = (event) => {
                this.messagesReceived++;
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('[PurgeWS] Parse error:', error);
                }
            };

            this.ws.onclose = (event) => {
                console.log('[PurgeWS] ❌ Disconnected:', event.code);
                this.stopHeartbeat();
                this.stopBatching();
                this.callbacks.onDisconnected?.();

                if (!this.isIntentionalClose) {
                    this.attemptReconnect();
                }
            };

            this.ws.onerror = (error) => {
                console.error('[PurgeWS] Error:', error);
                this.callbacks.onError?.('Connection error');
            };

        } catch (error) {
            console.error('[PurgeWS] Connection failed:', error);
            this.callbacks.onError?.('Failed to connect');
        }
    }

    private handleMessage(message: any): void {
        switch (message.type) {
            case 'sync':
                console.log('[PurgeWS] 📦 Sync:', message.players?.length || 0, 'players');
                this.callbacks.onSync?.(message.players || []);
                if (message.safeZone) {
                    this.callbacks.onSafeZoneUpdate?.(message.safeZone);
                }
                break;

            case 'player:update':
                this.callbacks.onPlayerUpdate?.(message.id, message.state);
                break;

            case 'player:connected':
                console.log('[PurgeWS] 👋 Player joined:', message.playerId?.slice(0, 8));
                this.callbacks.onPlayerJoined?.(message.playerId, message.state);
                break;

            case 'player:disconnected':
                console.log('[PurgeWS] 👋 Player left:', message.playerId?.slice(0, 8));
                this.callbacks.onPlayerLeft?.(message.playerId);
                break;

            case 'player:eliminated':
                console.log('[PurgeWS] 💀 Player eliminated:', message.playerId?.slice(0, 8));
                this.callbacks.onPlayerEliminated?.(message.playerId);
                break;

            case 'player:ready':
                console.log('[PurgeWS] ✅ Player ready:', message.playerId?.slice(0, 8));
                this.callbacks.onPlayerReady?.(message.playerId);
                break;

            case 'game:phase':
                console.log('[PurgeWS] 🎮 Phase:', message.phase);
                this.callbacks.onGamePhaseChange?.(message.phase);
                break;

            case 'game:countdown':
                console.log('[PurgeWS] ⏱️ Countdown started');
                this.callbacks.onCountdownStart?.(message.startTime, message.duration);
                break;

            case 'game:start':
                console.log('[PurgeWS] 🚀 Game started');
                this.callbacks.onGameStart?.();
                break;

            case 'game:winner':
                console.log('[PurgeWS] 🏆 Winner:', message.winnerId?.slice(0, 8));
                this.callbacks.onGameEnd?.(message.winnerId);
                break;

            case 'safezone:update':
                this.callbacks.onSafeZoneUpdate?.(message.safeZone);
                break;

            case 'pong':
                if (this.pingTime > 0) {
                    this.latency = Date.now() - this.pingTime;
                    this.pingTime = 0;
                }
                break;

            case 'error':
                console.error('[PurgeWS] Server error:', message.message);
                this.callbacks.onError?.(message.message);
                break;

            default:
                console.log('[PurgeWS] ❓ Unknown message:', message.type);
        }
    }

    // Public API
    queueUpdate(state: Partial<PlayerState>): void {
        this.updateQueue.push(state);
    }

    sendReady(): void {
        this.send({ type: 'player:ready' });
    }

    sendEliminated(): void {
        this.send({ type: 'player:eliminated' });
    }

    requestSync(): void {
        this.send({ type: 'request_sync' });
    }

    private startBatching(): void {
        this.stopBatching();
        this.batchInterval = setInterval(() => {
            if (this.updateQueue.length > 0 && this.isConnected()) {
                // Send only latest state
                const latestState = this.updateQueue[this.updateQueue.length - 1];
                this.send({
                    type: 'player:update',
                    state: latestState
                });
                this.updateQueue = [];
            }
        }, this.BATCH_INTERVAL);
    }

    private stopBatching(): void {
        if (this.batchInterval) {
            clearInterval(this.batchInterval);
            this.batchInterval = null;
        }
        this.updateQueue = [];
    }

    private send(message: any): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(message));
                this.messagesSent++;
            } catch (error) {
                console.error('[PurgeWS] Send error:', error);
            }
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (this.isConnected()) {
                this.pingTime = Date.now();
                this.send({ type: 'ping' });
            }
        }, 20000); // 20s
    }

    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    private attemptReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[PurgeWS] Max reconnect attempts');
            this.callbacks.onError?.('Connection lost');
            return;
        }

        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
        console.log(`[PurgeWS] Reconnecting in ${delay}ms...`);

        this.callbacks.onReconnecting?.(this.reconnectAttempts + 1);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectAttempts++;
            this.connect(this.callbacks);
        }, delay);
    }

    isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    getStats() {
        return {
            connected: this.isConnected(),
            gameId: this.gameId,
            playerId: this.playerId.slice(0, 8),
            latency: this.latency,
            messagesSent: this.messagesSent,
            messagesReceived: this.messagesReceived,
            connectionQuality: this.latency < 50 ? 'good' : this.latency < 150 ? 'fair' : 'poor'
        };
    }

    disconnect(): void {
        console.log('[PurgeWS] 🔌 Disconnecting');
        this.isIntentionalClose = true;
        this.stopHeartbeat();
        this.stopBatching();

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }

        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
    }
}

// Singleton with multi-handler support
class PurgeWSManagerSingleton {
    private instance: PurgeWSManager | null = null;
    private handlers: Map<string, PurgeCallbacks> = new Map();
    private currentGameId: string | null = null;
    private currentPlayerId: string | null = null;

    connect(gameId: string, playerId: string, handlerId: string, callbacks: PurgeCallbacks): void {
        console.log('[PurgeSingleton] Connect:', { gameId, playerId: playerId.slice(0, 8), handlerId });

        // Reuse if same game & player
        if (this.instance && this.currentGameId === gameId && this.currentPlayerId === playerId) {
            this.handlers.set(handlerId, callbacks);
            console.log('[PurgeSingleton] ♻️ Reusing connection');
            
            if (this.instance.isConnected()) {
                callbacks.onConnected?.();
            }
            return;
        }

        // Disconnect old
        if (this.instance) {
            console.log('[PurgeSingleton] 🔄 Switching games');
            this.instance.disconnect();
        }

        this.currentGameId = gameId;
        this.currentPlayerId = playerId;
        this.handlers.clear();
        this.handlers.set(handlerId, callbacks);

        this.instance = new PurgeWSManager(gameId, playerId);
        this.instance.connect(this.getMergedCallbacks());
    }

    private getMergedCallbacks(): PurgeCallbacks {
        return {
            onConnected: () => {
                this.handlers.forEach(h => h.onConnected?.());
            },
            onDisconnected: () => {
                this.handlers.forEach(h => h.onDisconnected?.());
            },
            onReconnecting: (attempt) => {
                this.handlers.forEach(h => h.onReconnecting?.(attempt));
            },
            onSync: (players) => {
                this.handlers.forEach(h => h.onSync?.(players));
            },
            onPlayerUpdate: (id, state) => {
                this.handlers.forEach(h => h.onPlayerUpdate?.(id, state));
            },
            onPlayerJoined: (id, state) => {
                this.handlers.forEach(h => h.onPlayerJoined?.(id, state));
            },
            onPlayerLeft: (id) => {
                this.handlers.forEach(h => h.onPlayerLeft?.(id));
            },
            onPlayerEliminated: (id) => {
                this.handlers.forEach(h => h.onPlayerEliminated?.(id));
            },
            onPlayerReady: (id) => {
                this.handlers.forEach(h => h.onPlayerReady?.(id));
            },
            onGamePhaseChange: (phase) => {
                this.handlers.forEach(h => h.onGamePhaseChange?.(phase));
            },
            onCountdownStart: (start, dur) => {
                this.handlers.forEach(h => h.onCountdownStart?.(start, dur));
            },
            onGameStart: () => {
                this.handlers.forEach(h => h.onGameStart?.());
            },
            onGameEnd: (winnerId) => {
                this.handlers.forEach(h => h.onGameEnd?.(winnerId));
            },
            onSafeZoneUpdate: (safeZone) => {
                this.handlers.forEach(h => h.onSafeZoneUpdate?.(safeZone));
            },
            onError: (error) => {
                this.handlers.forEach(h => h.onError?.(error));
            }
        };
    }

    queueUpdate(state: Partial<PlayerState>): void {
        this.instance?.queueUpdate(state);
    }

    sendReady(): void {
        this.instance?.sendReady();
    }

    sendEliminated(): void {
        this.instance?.sendEliminated();
    }

    requestSync(): void {
        this.instance?.requestSync();
    }

    isConnected(): boolean {
        return this.instance?.isConnected() || false;
    }

    unregisterHandler(handlerId: string): void {
        this.handlers.delete(handlerId);

        if (this.handlers.size === 0) {
            console.log('[PurgeSingleton] 🧹 No handlers left');
            this.instance?.disconnect();
            this.instance = null;
            this.currentGameId = null;
            this.currentPlayerId = null;
        }
    }

    disconnect(): void {
        this.instance?.disconnect();
        this.instance = null;
        this.handlers.clear();
        this.currentGameId = null;
        this.currentPlayerId = null;
    }

    getStats() {
        return this.instance?.getStats() || null;
    }
}

export const purgeWsManager = new PurgeWSManagerSingleton();
