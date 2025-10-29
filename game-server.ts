// server.ts - WebSocket Server for Purge Game
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ==================== TYPES ====================

interface PlayerState {
    id: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    speed: number;
    hasShield: boolean;
    alive: boolean;
    color: string;
    lastUpdate: number;
}

interface ConnectedClient {
    ws: WebSocket;
    playerId: string;
    gameId: string;
    isAlive: boolean;
}

interface GameRoom {
    gameId: string;
    phase: 'waiting' | 'countdown' | 'active' | 'ended';
    players: Map<string, PlayerState>;
    readyPlayers: Set<string>;
    deadline: number | null;
    countdownStartTime: number | null;
    countdownDuration: number;
    gameStartTime: number | null;
    winner: string | null;
}

// ==================== STATE ====================

const games = new Map<string, GameRoom>();
const clients = new Map<string, ConnectedClient>();

// ==================== HELPER FUNCTIONS ====================

function broadcast(gameId: string, message: any, excludePlayerId?: string) {
    clients.forEach((client, clientId) => {
        if (client.gameId === gameId && client.playerId !== excludePlayerId) {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify(message));
            }
        }
    });
}

function sendToPlayer(playerId: string, message: any) {
    const client = clients.get(playerId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
    }
}

function getOrCreateGame(gameId: string): GameRoom {
    if (!games.has(gameId)) {
        games.set(gameId, {
            gameId,
            phase: 'waiting',
            players: new Map(),
            readyPlayers: new Set(),
            deadline: null,
            countdownStartTime: null,
            countdownDuration: 10,
            gameStartTime: null,
            winner: null,
        });
    }
    return games.get(gameId)!;
}

function getPlayersArray(game: GameRoom) {
    return Array.from(game.players.values());
}

function checkForWinner(game: GameRoom) {
    const alivePlayers = Array.from(game.players.values()).filter(p => p.alive);

    if (alivePlayers.length === 1 && game.phase === 'active') {
        const winner = alivePlayers[0];
        game.winner = winner.id;
        game.phase = 'ended';

        console.log(`[Game ${game.gameId}] 🏆 Winner:`, winner.id.slice(0, 8));

        broadcast(game.gameId, {
            type: 'winner',
            winnerId: winner.id
        });

        broadcast(game.gameId, {
            type: 'game_phase_change',
            phase: 'ended'
        });
    }
}

// ==================== COUNTDOWN SYSTEM ====================

function startCountdown(game: GameRoom) {
    if (game.phase !== 'waiting') {
        console.log(`[Game ${game.gameId}] ⚠️ Cannot start countdown - game not in waiting phase`);
        return;
    }

    console.log(`[Game ${game.gameId}] ⏱️ Starting countdown...`);

    game.phase = 'countdown';
    game.countdownStartTime = Date.now();

    // Notify all clients
    broadcast(game.gameId, {
        type: 'game_phase_change',
        phase: 'countdown'
    });

    broadcast(game.gameId, {
        type: 'countdown_sync',
        startTime: game.countdownStartTime,
        duration: game.countdownDuration
    });

    // After countdown, start game
    setTimeout(() => {
        startGame(game);
    }, game.countdownDuration * 1000);
}

function startGame(game: GameRoom) {
    if (game.phase === 'ended') {
        console.log(`[Game ${game.gameId}] ⚠️ Game already ended`);
        return;
    }

    console.log(`[Game ${game.gameId}] 🎮 Starting game...`);

    game.phase = 'active';
    game.gameStartTime = Date.now();

    broadcast(game.gameId, {
        type: 'game_phase_change',
        phase: 'active'
    });

    console.log(`[Game ${game.gameId}] ✅ Game started with ${game.players.size} players`);
}

// ==================== DEADLINE CHECKER ====================

setInterval(() => {
    const now = Date.now();

    games.forEach((game) => {
        if (game.phase !== 'waiting' || !game.deadline) return;

        if (now >= game.deadline) {
            const readyCount = game.readyPlayers.size;
            const totalPlayers = game.players.size;

            console.log(`[Game ${game.gameId}] ⏰ Deadline reached! Ready: ${readyCount}/${totalPlayers}`);

            if (readyCount >= 2) {
                console.log(`[Game ${game.gameId}] 🚀 Starting countdown...`);
                startCountdown(game);
            } else if (readyCount === 1) {
                const winnerId = Array.from(game.readyPlayers)[0];
                game.winner = winnerId;
                game.phase = 'ended';

                console.log(`[Game ${game.gameId}] 🏆 Auto-winner (only 1 ready):`, winnerId.slice(0, 8));

                broadcast(game.gameId, {
                    type: 'winner',
                    winnerId
                });

                broadcast(game.gameId, {
                    type: 'game_phase_change',
                    phase: 'ended'
                });
            } else {
                console.log(`[Game ${game.gameId}] ⚠️ No players ready - extending deadline`);
                // Extend deadline by 1 hour
                game.deadline = now + 3600000;
            }
        }
    });
}, 1000);

// ==================== WEBSOCKET HANDLERS ====================

wss.on('connection', (ws: WebSocket) => {
    console.log('[WebSocket] 🔗 New connection');

    let clientId: string | null = null;
    let playerId: string | null = null;
    let gameId: string | null = null;

    ws.on('message', (data: Buffer) => {
        try {
            const message = JSON.parse(data.toString());
            const { type } = message;

            // ==================== CONNECTION ====================
            if (type === 'connect') {
                gameId = message.gameId;
                playerId = message.playerId;
                clientId = `${gameId}-${playerId}`;

                console.log(`[WebSocket] 👋 Player connecting: ${playerId.slice(0, 8)} to game ${gameId}`);

                // Store client
                clients.set(playerId, {
                    ws,
                    playerId,
                    gameId,
                    isAlive: true
                });

                // Get or create game
                const game = getOrCreateGame(gameId);

                // Add player if not exists
                if (!game.players.has(playerId)) {
                    const colors = ['#FF4444', '#44FF44', '#4444FF', '#FFFF44', '#FF44FF', '#44FFFF'];
                    const playerIndex = game.players.size;

                    game.players.set(playerId, {
                        id: playerId,
                        x: 100 + (playerIndex * 50),
                        y: 100 + (playerIndex * 50),
                        hp: 100,
                        maxHp: 100,
                        speed: 3,
                        hasShield: false,
                        alive: true,
                        color: colors[playerIndex % colors.length],
                        lastUpdate: Date.now()
                    });
                }

                // Send connected event
                ws.send(JSON.stringify({ type: 'connected' }));

                // Send sync with all players
                ws.send(JSON.stringify({
                    type: 'sync',
                    players: getPlayersArray(game)
                }));

                // Notify others
                broadcast(gameId, {
                    type: 'player_connected',
                    playerId
                }, playerId);

                console.log(`[Game ${gameId}] ✅ Player ${playerId.slice(0, 8)} connected (${game.players.size} total)`);
            }

            // ==================== MARK READY ====================
            else if (type === 'mark_ready') {
                if (!playerId || !gameId) return;

                const game = games.get(gameId);
                if (!game) {
                    console.log(`[WebSocket] ❌ Game ${gameId} not found`);
                    return;
                }

                game.readyPlayers.add(playerId);

                console.log(`[Game ${gameId}] ✅ Player ${playerId.slice(0, 8)} marked ready (${game.readyPlayers.size}/${game.players.size})`);

                // Broadcast to all players
                broadcast(gameId, {
                    type: 'player_ready',
                    playerId,
                    readyCount: game.readyPlayers.size,
                    totalPlayers: game.players.size
                });

                // Check if all players are ready
                if (game.readyPlayers.size === game.players.size && game.players.size > 0) {
                    console.log(`[Game ${gameId}] 🎮 All players ready!`);
                }
            }

            // ==================== SET DEADLINE ====================
            else if (type === 'set_deadline') {
                if (!gameId) return;

                const game = games.get(gameId);
                if (!game) return;

                game.deadline = message.deadline;

                console.log(`[Game ${gameId}] ⏰ Deadline set to ${new Date(message.deadline).toISOString()}`);
            }

            // ==================== START GAME ====================
            else if (type === 'start_game') {
                if (!gameId) return;

                const game = games.get(gameId);
                if (!game) {
                    console.log(`[WebSocket] ❌ Game ${gameId} not found`);
                    return;
                }

                const readyCount = game.readyPlayers.size;
                const totalPlayers = game.players.size;

                console.log(`[Game ${gameId}] 🚀 Start game requested (Ready: ${readyCount}/${totalPlayers})`);

                if (readyCount >= 2) {
                    startCountdown(game);
                } else if (readyCount === 1) {
                    // Auto-winner
                    const winnerId = Array.from(game.readyPlayers)[0];
                    game.winner = winnerId;
                    game.phase = 'ended';

                    console.log(`[Game ${gameId}] 🏆 Auto-winner (only 1 ready):`, winnerId.slice(0, 8));

                    broadcast(gameId, {
                        type: 'winner',
                        winnerId
                    });

                    broadcast(gameId, {
                        type: 'game_phase_change',
                        phase: 'ended'
                    });
                } else {
                    console.log(`[Game ${gameId}] ⚠️ Cannot start - not enough ready players`);
                }
            }

            // ==================== PLAYER UPDATE ====================
            else if (type === 'update') {
                if (!playerId || !gameId) return;

                const game = games.get(gameId);
                if (!game) return;

                const player = game.players.get(playerId);
                if (!player) return;

                // Update player state
                Object.assign(player, message.data, {
                    id: playerId, // Ensure ID doesn't change
                    lastUpdate: Date.now()
                });

                // Broadcast to other players
                broadcast(gameId, {
                    type: 'update',
                    playerId,
                    state: player
                }, playerId);
            }

            // ==================== PLAYER ELIMINATED ====================
            else if (type === 'eliminated') {
                if (!playerId || !gameId) return;

                const game = games.get(gameId);
                if (!game) return;

                const player = game.players.get(playerId);
                if (!player) return;

                player.alive = false;

                console.log(`[Game ${gameId}] 💀 Player eliminated:`, playerId.slice(0, 8));

                // Broadcast to all players
                broadcast(gameId, {
                    type: 'eliminated',
                    playerId
                });

                // Check for winner
                checkForWinner(game);
            }

            // ==================== DECLARE WINNER ====================
            else if (type === 'winner') {
                if (!gameId) return;

                const game = games.get(gameId);
                if (!game) return;

                game.winner = message.winnerId;
                game.phase = 'ended';

                console.log(`[Game ${gameId}] 🏆 Winner declared:`, message.winnerId.slice(0, 8));

                broadcast(gameId, {
                    type: 'winner',
                    winnerId: message.winnerId
                });

                broadcast(gameId, {
                    type: 'game_phase_change',
                    phase: 'ended'
                });
            }

        } catch (error) {
            console.error('[WebSocket] ❌ Error processing message:', error);
        }
    });

    ws.on('close', () => {
        if (playerId && gameId) {
            console.log(`[WebSocket] 🔌 Player disconnected: ${playerId.slice(0, 8)} from game ${gameId}`);

            clients.delete(playerId);

            // Notify others
            broadcast(gameId, {
                type: 'player_disconnected',
                playerId
            });

            // Optionally mark player as disconnected but keep in game
            const game = games.get(gameId);
            if (game) {
                const player = game.players.get(playerId);
                if (player) {
                    // Keep player in game for potential reconnection
                    console.log(`[Game ${gameId}] ⚠️ Player ${playerId.slice(0, 8)} disconnected but kept in game`);
                }
            }
        }
    });

    ws.on('error', (error) => {
        console.error('[WebSocket] ❌ Error:', error);
    });
});

// ==================== HEARTBEAT ====================

const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if ((ws as any).isAlive === false) {
            return ws.terminate();
        }

        (ws as any).isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(heartbeatInterval);
});

// ==================== REST API ====================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        games: games.size,
        connections: clients.size,
        timestamp: Date.now()
    });
});

app.get('/api/game/:gameId', (req, res) => {
    const gameId = req.params.gameId;
    const game = games.get(gameId);

    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }

    res.json({
        gameId: game.gameId,
        phase: game.phase,
        players: Array.from(game.players.values()).map(p => ({
            id: p.id,
            alive: p.alive,
            hp: p.hp,
            x: p.x,
            y: p.y
        })),
        readyPlayers: Array.from(game.readyPlayers),
        winner: game.winner
    });
});

app.get('/api/games', (req, res) => {
    const gamesList = Array.from(games.values()).map(game => ({
        gameId: game.gameId,
        phase: game.phase,
        playerCount: game.players.size,
        readyCount: game.readyPlayers.size,
        winner: game.winner
    }));

    res.json({ games: gamesList });
});

app.post('/api/game/:gameId/reset', (req, res) => {
    const gameId = req.params.gameId;

    if (games.has(gameId)) {
        games.delete(gameId);
        console.log(`[API] 🗑️ Game ${gameId} deleted`);
        res.json({ success: true, message: 'Game reset' });
    } else {
        res.status(404).json({ error: 'Game not found' });
    }
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🎮 PURGE GAME - WebSocket Server                   ║
║                                                       ║
║   🚀 Server running on port ${PORT}                    ║
║   📡 WebSocket: ws://localhost:${PORT}                  ║
║   🌐 HTTP API: http://localhost:${PORT}                 ║
║   💚 Health check: http://localhost:${PORT}/health      ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
    `);
});

export { wss, games };