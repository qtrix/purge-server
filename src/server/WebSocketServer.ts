// src/server/WebSocketServer.ts - WebSocket Connection Management

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
}

export class WebSocketServer {
    private wss: WSServer;
    private clients: Map<WebSocket, ClientConnection>;
    private roomManager: RoomManager;
    private log: ReturnType<typeof logger.child>;

    private heartbeatInterval?: NodeJS.Timeout;
    private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds

    constructor(server: any) {
        this.wss = new WSServer({ server, path: '/game' });
        this.clients = new Map();
        this.roomManager = new RoomManager();
        this.log = logger.child('WSServer');

        this.setupWebSocketServer();
        this.startHeartbeat();

        this.log.info('WebSocket server initialized', {
            path: '/game',
            heartbeatInterval: this.HEARTBEAT_INTERVAL
        });
    }

    private setupWebSocketServer(): void {
        this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
            this.handleConnection(ws, request);
        });

        this.wss.on('error', (error) => {
            this.log.error('WebSocket server error', { error: error.message });
        });
    }

    /**
     * Handle new WebSocket connection
     */
    private handleConnection(ws: WebSocket, request: IncomingMessage): void {
        try {
            // Parse query parameters
            const url = new URL(request.url || '', `http://${request.headers.host}`);
            const gameId = url.searchParams.get('gameId');
            const playerId = url.searchParams.get('playerId');

            if (!gameId || !playerId) {
                this.log.warn('Connection rejected - missing parameters');
                this.sendError(ws, 'Missing gameId or playerId');
                ws.close(1008, 'Missing parameters');
                return;
            }

            // For now, use playerId as wallet address
            // In production, verify wallet signature
            const walletAddress = playerId;
            const vsolBalance = 1000; // Get from blockchain in production

            this.log.info('New connection', {
                gameId,
                playerId: playerId.slice(0, 8),
                ip: request.socket.remoteAddress
            });

            // Add to room
            const result = this.roomManager.addPlayerToRoom(
                gameId,
                playerId,
                walletAddress,
                vsolBalance,
                ws
            );

            if (!result.success) {
                this.sendError(ws, result.error || 'Failed to join game');
                ws.close(1008, result.error);
                return;
            }

            // Store connection info
            const clientInfo: ClientConnection = {
                ws,
                gameId,
                playerId,
                walletAddress,
                isAlive: true,
                lastPing: Date.now()
            };

            this.clients.set(ws, clientInfo);

            // Setup message handlers
            ws.on('message', (data) => this.handleMessage(ws, data));
            ws.on('close', () => this.handleClose(ws));
            ws.on('error', (error) => this.handleError(ws, error));
            ws.on('pong', () => this.handlePong(ws));

        } catch (error: any) {
            this.log.error('Connection setup failed', { error: error.message });
            ws.close(1011, 'Internal error');
        }
    }

    /**
     * Handle incoming message
     */
    private handleMessage(ws: WebSocket, data: WebSocket.Data): void {
        const client = this.clients.get(ws);
        if (!client) return;

        try {
            const message: WSMessage = JSON.parse(data.toString());

            switch (message.type) {
                case 'ping':
                    this.send(ws, { type: 'pong' });
                    break;

                case 'request_sync':
                    // Room will handle sync
                    break;

                case 'player:update':
                    const room = this.roomManager.getRoom(client.gameId);
                    if (room && message.state) {
                        room.updatePlayer(client.playerId, message.state);
                    }
                    break;

                case 'player:ready':
                    const readyRoom = this.roomManager.getRoom(client.gameId);
                    if (readyRoom) {
                        readyRoom.markPlayerReady(client.playerId);
                    }
                    break;

                default:
                    this.log.warn('Unknown message type', {
                        type: message.type,
                        playerId: client.playerId.slice(0, 8)
                    });
            }

        } catch (error: any) {
            this.log.error('Message handling error', {
                error: error.message,
                playerId: client.playerId?.slice(0, 8)
            });
            this.sendError(ws, 'Invalid message format');
        }
    }

    /**
     * Handle connection close
     */
    private handleClose(ws: WebSocket): void {
        const client = this.clients.get(ws);
        if (!client) return;

        this.log.info('Connection closed', {
            playerId: client.playerId.slice(0, 8),
            gameId: client.gameId
        });

        this.roomManager.removePlayerFromRoom(client.gameId, client.playerId);
        this.clients.delete(ws);
    }

    /**
     * Handle connection error
     */
    private handleError(ws: WebSocket, error: Error): void {
        const client = this.clients.get(ws);
        
        this.log.error('Connection error', {
            error: error.message,
            playerId: client?.playerId?.slice(0, 8)
        });
    }

    /**
     * Handle pong response
     */
    private handlePong(ws: WebSocket): void {
        const client = this.clients.get(ws);
        if (client) {
            client.isAlive = true;
            client.lastPing = Date.now();
        }
    }

    /**
     * Send message to client
     */
    private send(ws: WebSocket, message: WSMessage): void {
        if (ws.readyState !== WebSocket.OPEN) return;

        try {
            ws.send(JSON.stringify({
                ...message,
                timestamp: Date.now()
            }));
        } catch (error: any) {
            this.log.error('Send error', { error: error.message });
        }
    }

    /**
     * Send error message
     */
    private sendError(ws: WebSocket, error: string): void {
        this.send(ws, {
            type: 'error',
            message: error
        });
    }

    /**
     * Start heartbeat to detect dead connections
     */
    private startHeartbeat(): void {
        this.heartbeatInterval = setInterval(() => {
            this.clients.forEach((client, ws) => {
                if (!client.isAlive) {
                    this.log.warn('Terminating dead connection', {
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

    /**
     * Get server statistics
     */
    getStats() {
        return {
            connections: this.clients.size,
            rooms: this.roomManager.getAllStats(),
            uptime: process.uptime()
        };
    }

    /**
     * Shutdown server
     */
    shutdown(): void {
        this.log.info('Shutting down WebSocket server');

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
