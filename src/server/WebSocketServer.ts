
// src/server/WebSocketServer.ts - WITH DEBUG LOGGING

import WebSocket, { WebSocketServer as WSServer } from 'ws';
import { IncomingMessage } from 'http';
import { URL } from 'url';
import { logger } from '../utils/Logger';
import { RoomManager } from '../managers/RoomManager';
import { WSMessage } from '../types';

interface ClientConnection {
    ws: WebSocket;
    gameId: string;
    playerId: string;
    walletAddress: string;
    isAlive: boolean;
    lastPing: number;
    hasJoined: boolean;
}

export class WebSocketServer {
    private wss: WSServer;
    private clients: Map<WebSocket, ClientConnection>;
    private roomManager: RoomManager;
    private log: ReturnType<typeof logger.child>;

    private heartbeatInterval?: NodeJS.Timeout;
    private readonly HEARTBEAT_INTERVAL = 30000;

    constructor(server: any) {
        this.wss = new WSServer({ server, path: '/game' });
        this.clients = new Map();
        this.roomManager = new RoomManager();
        this.log = logger.child('WSServer');

        this.setupWebSocketServer();
        this.startHeartbeat();

        this.log.info('WebSocket server initialized');
    }

    private setupWebSocketServer(): void {
        this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
            this.handleConnection(ws, request);
        });

        this.wss.on('error', (error) => {
            this.log.error('WebSocket server error', { error: error.message });
        });
    }

    private handleConnection(ws: WebSocket, request: IncomingMessage): void {
        try {
            const url = new URL(request.url || '', `http://${request.headers.host}`);
            const gameId = url.searchParams.get('gameId');
            const playerId = url.searchParams.get('playerId');

            this.log.info('🔗 [Connection] Attempt', {
                gameId,
                playerId: playerId?.slice(0, 8),
                ip: request.socket.remoteAddress
            });

            if (!gameId || !playerId) {
                this.log.warn('❌ [Connection] Rejected - missing parameters');
                this.sendError(ws, 'Missing gameId or playerId');
                ws.close(1008, 'Missing parameters');
                return;
            }

            const walletAddress = playerId;
            const clientInfo: ClientConnection = {
                ws,
                gameId,
                playerId,
                walletAddress,
                isAlive: true,
                lastPing: Date.now(),
                hasJoined: false
            };

            this.clients.set(ws, clientInfo);

            ws.on('message', (data) => this.handleMessage(ws, data));
            ws.on('close', () => this.handleClose(ws));
            ws.on('error', (error) => this.handleError(ws, error));
            ws.on('pong', () => this.handlePong(ws));

            this.log.info('✅ [Connection] Established - waiting for join', {
                playerId: playerId.slice(0, 8),
                gameId
            });

            this.send(ws, {
                type: 'connected',
                message: 'Connected. Please send join message with vsolBalance.'
            });

        } catch (error: any) {
            this.log.error('❌ [Connection] Setup failed', { error: error.message });
            ws.close(1011, 'Internal error');
        }
    }

    private handleMessage(ws: WebSocket, data: WebSocket.Data): void {
        const client = this.clients.get(ws);
        if (!client) return;

        try {
            const message: WSMessage = JSON.parse(data.toString());

            this.log.info('📥 [Message] Received', {
                type: message.type,
                playerId: client.playerId.slice(0, 8),
                hasJoined: client.hasJoined
            });

            switch (message.type) {
                case 'join':
                    this.handleJoin(ws, client, message);
                    break;

                case 'ping':
                    this.send(ws, { type: 'pong' });
                    break;

                case 'request_sync':
                    if (!client.hasJoined) {
                        this.log.warn('⚠️ [Sync] Player not joined yet', {
                            playerId: client.playerId.slice(0, 8)
                        });
                        this.sendError(ws, 'Must join first');
                        return;
                    }
                    const room = this.roomManager.getRoom(client.gameId);
                    if (room) {
                        this.log.info('🔄 [Sync] Requested', {
                            playerId: client.playerId.slice(0, 8)
                        });
                    }
                    break;

                case 'player:update':
                    if (!client.hasJoined) {
                        this.sendError(ws, 'Must join first');
                        return;
                    }
                    const updateRoom = this.roomManager.getRoom(client.gameId);
                    if (updateRoom && message.state) {
                        updateRoom.updatePlayer(client.playerId, message.state);
                    }
                    break;

                case 'player:ready':
                    if (!client.hasJoined) {
                        this.sendError(ws, 'Must join first');
                        return;
                    }
                    this.log.info('✅ [Ready] Player marked ready', {
                        playerId: client.playerId.slice(0, 8)
                    });
                    const readyRoom = this.roomManager.getRoom(client.gameId);
                    if (readyRoom) {
                        readyRoom.markPlayerReady(client.playerId);
                    }
                    break;

                default:
                    this.log.warn('⚠️ [Message] Unknown type', {
                        type: message.type,
                        playerId: client.playerId.slice(0, 8)
                    });
            }

        } catch (error: any) {
            this.log.error('❌ [Message] Handling error', {
                error: error.message,
                playerId: client.playerId?.slice(0, 8)
            });
            this.sendError(ws, 'Invalid message format');
        }
    }

    private handleJoin(ws: WebSocket, client: ClientConnection, message: WSMessage): void {
        if (client.hasJoined) {
            this.log.warn('⚠️ [Join] Player already joined', {
                playerId: client.playerId.slice(0, 8)
            });
            return;
        }

        const vsolBalance = message.vsolBalance || 0;

        this.log.info('🎮 [Join] Processing', {
            playerId: client.playerId.slice(0, 8),
            gameId: client.gameId,
            vsolBalance: (vsolBalance / 1e9).toFixed(4) + ' SOL'
        });

        if (vsolBalance <= 0) {
            this.log.error('❌ [Join] Invalid vsolBalance', {
                playerId: client.playerId.slice(0, 8),
                vsolBalance
            });
            this.sendError(ws, 'Invalid vsolBalance');
            ws.close(1008, 'Invalid vsolBalance');
            return;
        }

        const result = this.roomManager.addPlayerToRoom(
            client.gameId,
            client.playerId,
            client.walletAddress,
            vsolBalance,
            ws
        );

        if (!result.success) {
            this.log.error('❌ [Join] Failed', {
                playerId: client.playerId.slice(0, 8),
                error: result.error
            });
            this.sendError(ws, result.error || 'Failed to join game');
            ws.close(1008, result.error);
            return;
        }

        client.hasJoined = true;

        this.log.info('✅ [Join] Success', {
            playerId: client.playerId.slice(0, 8),
            gameId: client.gameId
        });

        this.send(ws, {
            type: 'joined',
            message: 'Successfully joined game'
        });
    }

    private handleClose(ws: WebSocket): void {
        const client = this.clients.get(ws);
        if (!client) return;

        this.log.info('🔌 [Disconnect]', {
            playerId: client.playerId.slice(0, 8),
            gameId: client.gameId,
            hadJoined: client.hasJoined
        });

        const room = this.roomManager.getRoom(client.gameId);

        if (!room || room.getPhase() === 'ended' || !client.hasJoined) {
            this.roomManager.removePlayerFromRoom(client.gameId, client.playerId);
            this.log.info('🗑️ [Disconnect] Player removed from room', {
                playerId: client.playerId.slice(0, 8)
            });
        } else {
            this.log.info('⏳ [Disconnect] Keeping player for reconnection', {
                playerId: client.playerId.slice(0, 8),
                phase: room.getPhase()
            });
        }

        this.clients.delete(ws);
    }

    private handleError(ws: WebSocket, error: Error): void {
        const client = this.clients.get(ws);
        this.log.error('❌ [Error]', {
            error: error.message,
            playerId: client?.playerId?.slice(0, 8)
        });
    }

    private handlePong(ws: WebSocket): void {
        const client = this.clients.get(ws);
        if (client) {
            client.isAlive = true;
            client.lastPing = Date.now();
        }
    }

    private send(ws: WebSocket, message: WSMessage): void {
        if (ws.readyState !== WebSocket.OPEN) return;

        try {
            ws.send(JSON.stringify({
                ...message,
                timestamp: Date.now()
            }));
        } catch (error: any) {
            this.log.error('❌ [Send] Error', { error: error.message });
        }
    }

    private sendError(ws: WebSocket, error: string): void {
        this.send(ws, {
            type: 'error',
            message: error
        });
    }

    private startHeartbeat(): void {
        this.heartbeatInterval = setInterval(() => {
            this.clients.forEach((client, ws) => {
                if (!client.isAlive) {
                    this.log.warn('💀 [Heartbeat] Terminating dead connection', {
                        playerId: client.playerId.slice(0, 8)
                    });
                    ws.terminate();
                    this.clients.delete(ws);
                    return;
                }

                client.isAlive = false;
                ws.ping();
            });
        }, this.HEARTBEAT_INTERVAL);
    }

    getStats() {
        return {
            connections: this.clients.size,
            rooms: this.roomManager.getAllStats(),
            uptime: process.uptime()
        };
    }

    shutdown(): void {
        this.log.info('🛑 Shutting down WebSocket server');

        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        this.roomManager.shutdown();

        this.clients.forEach((client, ws) => {
            ws.close(1001, 'Server shutdown');
        });

        this.wss.close();
    }
}
