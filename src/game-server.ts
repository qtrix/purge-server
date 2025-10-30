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
    prizeAmount: number; // ✅ NEW: Track prize amount
    ended: boolean; // ✅ NEW: Track if game is permanently ended
    endedAt: number | null; // ✅ NEW: When game ended
    safeZoneRadius: number;
    targetZoneRadius: number;
    zoneShrinkRate: number;
}

// ==================== STATE ====================

const games = new Map<string, GameRoom>();
const clients = new Map<string, ConnectedClient>();

// ==================== HELPER FUNCTIONS ====================

function broadcast(gameId: string, message: any, excludePlayerId?: string): void {
    let sentCount = 0;
    clients.forEach((client) => {
        if (client.gameId === gameId && client.playerId !== excludePlayerId) {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify(message));
                sentCount++;
            }
        }
    });
    if (sentCount > 0) {
        console.log(`[Broadcast] Sent to ${sentCount} clients in game ${gameId}`);
    }
}

function sendToPlayer(playerId: string, message: any): void {
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
            prizeAmount: 0, // ✅ NEW
            ended: false, // ✅ NEW
            endedAt: null, // ✅ NEW
            safeZoneRadius: 400,
            targetZoneRadius: 50,
            zoneShrinkRate: 0.5
        });
    }
    return games.get(gameId)!;
}

function getPlayersArray(game: GameRoom): PlayerState[] {
    return Array.from(game.players.values());
}

// ✅ ENHANCED: Check for winner and mark game as ended
function checkForWinner(game: GameRoom): void {
    const alivePlayers = Array.from(game.players.values()).filter(p => p.alive);

    if (alivePlayers.length === 1 && game.phase === 'active' && !game.ended) {
        const winner = alivePlayers[0];

        // ✅ Mark game as ended
        game.ended = true;
        game.endedAt = Date.now();
        game.winner = winner.id;
        game.phase = 'ended';

        console.log(`[Game ${game.gameId}] 🏆 Winner:`, winner.id.slice(0, 8));
        console.log(`[Game ${game.gameId}] ✅ Game marked as ENDED`);

        // ✅ Broadcast winner
        broadcast(game.gameId, {
            type: 'winner',
            winnerId: winner.id,
            prizeAmount: game.prizeAmount
        });

        // ✅ Broadcast phase change
        broadcast(game.gameId, {
            type: 'game_phase_change',
            phase: 'ended'
        });

        // ✅ Broadcast game ended
        broadcast(game.gameId, {
            type: 'game_ended',
            winnerId: winner.id,
            prizeAmount: game.prizeAmount,
            endedAt: game.endedAt
        });

        // ✅ Schedule cleanup after 5 minutes
        setTimeout(() => {
            cleanupGame(game.gameId);
        }, 5 * 60 * 1000);
    }
}

// ✅ NEW: Cleanup game function
function cleanupGame(gameId: string): void {
    const game = games.get(gameId);
    if (!game) return;

    console.log(`[Game ${gameId}] 🧹 Cleaning up game...`);

    // Close all connections
    clients.forEach((client) => {
        if (client.gameId === gameId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.close();
        }
    });

    // Remove game
    games.delete(gameId);

    console.log(`[Game ${gameId}] ✅ Game cleaned up`);
}

// ==================== COUNTDOWN SYSTEM ====================

function startCountdown(game: GameRoom): void {
    // ✅ Don't start if game ended
    if (game.ended) {
        console.log(`[Game ${game.gameId}] ⚠️ Cannot start countdown - game has ended`);
        return;
    }

    if (game.phase !== 'waiting') {
        console.log(`[Game ${game.gameId}] ⚠️ Cannot start countdown - game not in waiting phase`);
        return;
    }

    console.log(`[Game ${game.gameId}] ⏱️ Starting countdown...`);

    game.phase = 'countdown';
    game.countdownStartTime = Date.now();

    broadcast(game.gameId, {
        type: 'game_phase_change',
        phase: 'countdown'
    });

    broadcast(game.gameId, {
        type: 'countdown_sync',
        startTime: game.countdownStartTime,
        duration: game.countdownDuration
    });

    setTimeout(() => {
        startGame(game);
    }, game.countdownDuration * 1000);
}

function startGame(game: GameRoom): void {
    // ✅ Don't start if game ended
    if (game.ended) {
        console.log(`[Game ${game.gameId}] ⚠️ Game already ended - cannot start`);
        return;
    }

    if (game.phase === 'ended') {
        console.log(`[Game ${game.gameId}] ⚠️ Game already ended`);
        return;
    }

    console.log(`[Game ${game.gameId}] 🎮 Starting game...`);

    game.phase = 'active';
    game.gameStartTime = Date.now();
    game.safeZoneRadius = 400;

    broadcast(game.gameId, {
        type: 'game_phase_change',
        phase: 'active'
    });

    broadcast(game.gameId, {
        type: 'game_start_sync',
        startTime: game.gameStartTime
    });

    console.log(`[Game ${game.gameId}] ✅ Game started with ${game.players.size} players`);
}

// ==================== GAME STATE SYNC ====================

setInterval(() => {
    games.forEach((game) => {
        // ✅ Only sync active games that haven't ended
        if (game.phase === 'active' && game.gameStartTime && !game.ended) {
            const elapsedSeconds = Math.floor((Date.now() - game.gameStartTime) / 1000);

            game.safeZoneRadius = Math.max(
                game.targetZoneRadius,
                game.safeZoneRadius - game.zoneShrinkRate
            );

            broadcast(game.gameId, {
                type: 'game_state_sync',
                gameTime: elapsedSeconds,
                safeZoneRadius: game.safeZoneRadius,
                alivePlayers: Array.from(game.players.values()).filter(p => p.alive).length
            });

            console.log(`[Game ${game.gameId}] 📡 Sync: Time=${elapsedSeconds}s, Zone=${game.safeZoneRadius.toFixed(1)}m`);
        }
    });
}, 1000);

// ==================== DEADLINE CHECKER ====================

setInterval(() => {
    const now = Date.now();

    games.forEach((game) => {
        // ✅ Don't process if game ended
        if (game.phase !== 'waiting' || !game.deadline || game.ended) return;

        if (now >= game.deadline) {
            const readyCount = game.readyPlayers.size;
            const totalPlayers = game.players.size;

            console.log(`[Game ${game.gameId}] ⏰ Deadline reached! Ready: ${readyCount}/${totalPlayers}`);

            if (readyCount >= 2) {
                console.log(`[Game ${game.gameId}] 🚀 Starting countdown...`);
                startCountdown(game);
            } else if (readyCount === 1) {
                const winnerId = Array.from(game.readyPlayers)[0];

                // ✅ Mark game as ended
                game.ended = true;
                game.endedAt = Date.now();
                game.winner = winnerId;
                game.phase = 'ended';

                console.log(`[Game ${game.gameId}] 🏆 Auto-winner (only 1 ready):`, winnerId.slice(0, 8));

                broadcast(game.gameId, {
                    type: 'winner',
                    winnerId,
                    prizeAmount: game.prizeAmount
                });

                broadcast(game.gameId, {
                    type: 'game_phase_change',
                    phase: 'ended'
                });

                broadcast(game.gameId, {
                    type: 'game_ended',
                    winnerId,
                    prizeAmount: game.prizeAmount
                });
            } else {
                console.log(`[Game ${game.gameId}] ⚠️ No players ready - extending deadline`);
                game.deadline = now + 3600000;
            }
        }
    });
}, 1000);

// ==================== WEBSOCKET HANDLERS ====================

wss.on('connection', (ws: WebSocket) => {
    console.log('[WebSocket] 🔗 New connection');

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

                if (!playerId || !gameId) {
                    console.log('[WebSocket] ❌ Missing playerId or gameId');
                    return;
                }

                console.log(`[WebSocket] 👋 Player connecting: ${playerId.slice(0, 8)} to game ${gameId}`);

                const game = getOrCreateGame(gameId);

                // ✅ Check if game has ended
                if (game.ended) {
                    console.log(`[WebSocket] ❌ Game ${gameId} has ended - rejecting connection`);

                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'This game has already ended. Please join a different game.'
                    }));

                    ws.send(JSON.stringify({
                        type: 'game_ended',
                        winnerId: game.winner,
                        prizeAmount: game.prizeAmount
                    }));

                    ws.close(1008, 'Game has ended');
                    return;
                }

                clients.set(playerId, {
                    ws,
                    playerId,
                    gameId,
                    isAlive: true
                });

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

                ws.send(JSON.stringify({ type: 'connected' }));

                ws.send(JSON.stringify({
                    type: 'sync',
                    players: getPlayersArray(game),
                    readyPlayers: Array.from(game.readyPlayers)
                }));

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

                // ✅ Don't allow marking ready if game ended
                if (game.ended) {
                    console.log(`[WebSocket] ❌ Cannot mark ready - game has ended`);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Game has ended'
                    }));
                    return;
                }

                game.readyPlayers.add(playerId);

                console.log(`[Game ${gameId}] ✅ Player ${playerId.slice(0, 8)} marked ready (${game.readyPlayers.size}/${game.players.size})`);

                broadcast(gameId, {
                    type: 'ready_players_update',
                    readyPlayers: Array.from(game.readyPlayers),
                    readyCount: game.readyPlayers.size,
                    totalPlayers: game.players.size
                });

                if (game.readyPlayers.size === game.players.size && game.players.size > 0) {
                    console.log(`[Game ${gameId}] 🎮 All players ready!`);
                }
            }

            // ==================== REQUEST SYNC ====================
            else if (type === 'request_sync') {
                if (!playerId || !gameId) return;

                const game = games.get(gameId);
                if (!game) return;

                sendToPlayer(playerId, {
                    type: 'sync',
                    players: getPlayersArray(game),
                    readyPlayers: Array.from(game.readyPlayers)
                });

                console.log(`[Game ${gameId}] 📡 Sync sent to ${playerId.slice(0, 8)}`);
            }

            // ==================== SET DEADLINE ====================
            else if (type === 'set_deadline') {
                if (!gameId) return;

                const game = games.get(gameId);
                if (!game || game.ended) return;

                game.deadline = message.deadline;

                console.log(`[Game ${gameId}] ⏰ Deadline set to ${new Date(message.deadline).toISOString()}`);
            }

            // ==================== SET PRIZE AMOUNT ====================
            else if (type === 'set_prize_amount') {
                if (!gameId) return;

                const game = games.get(gameId);
                if (!game) return;

                game.prizeAmount = message.prizeAmount;

                console.log(`[Game ${gameId}] 💰 Prize amount set to ${game.prizeAmount} SOL`);
            }

            // ==================== START GAME ====================
            else if (type === 'start_game') {
                if (!gameId) return;

                const game = games.get(gameId);
                if (!game) {
                    console.log(`[WebSocket] ❌ Game ${gameId} not found`);
                    return;
                }

                // ✅ Don't allow starting if game ended
                if (game.ended) {
                    console.log(`[WebSocket] ❌ Cannot start game - already ended`);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Game has already ended'
                    }));
                    return;
                }

                const readyCount = game.readyPlayers.size;
                const totalPlayers = game.players.size;

                console.log(`[Game ${gameId}] 🚀 Start game requested (Ready: ${readyCount}/${totalPlayers})`);

                if (readyCount >= 2) {
                    startCountdown(game);
                } else if (readyCount === 1) {
                    const winnerId = Array.from(game.readyPlayers)[0];

                    // ✅ Mark game as ended
                    game.ended = true;
                    game.endedAt = Date.now();
                    game.winner = winnerId;
                    game.phase = 'ended';

                    console.log(`[Game ${gameId}] 🏆 Auto-winner (only 1 ready):`, winnerId.slice(0, 8));

                    broadcast(gameId, {
                        type: 'winner',
                        winnerId,
                        prizeAmount: game.prizeAmount
                    });

                    broadcast(gameId, {
                        type: 'game_phase_change',
                        phase: 'ended'
                    });

                    broadcast(gameId, {
                        type: 'game_ended',
                        winnerId,
                        prizeAmount: game.prizeAmount
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

                // ✅ Ignore updates if game ended
                if (game.ended) {
                    // console.log(`[Game ${gameId}] Ignoring update from ${playerId.slice(0, 8)} - game has ended`);
                    return;
                }

                const player = game.players.get(playerId);
                if (!player) return;

                Object.assign(player, message.data, {
                    id: playerId,
                    lastUpdate: Date.now()
                });

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
                if (!game || game.ended) return;

                const player = game.players.get(playerId);
                if (!player) return;

                player.alive = false;

                console.log(`[Game ${gameId}] 💀 Player eliminated:`, playerId.slice(0, 8));

                broadcast(gameId, {
                    type: 'eliminated',
                    playerId
                });

                checkForWinner(game);
            }

            // ==================== DECLARE WINNER ====================
            else if (type === 'winner') {
                if (!gameId) return;

                const game = games.get(gameId);
                if (!game) return;

                // ✅ Prevent multiple winner declarations
                if (game.ended) {
                    console.log(`[Game ${gameId}] ⚠️ Winner already declared - ignoring duplicate`);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Winner already declared for this game'
                    }));
                    return;
                }

                const winnerId = message.winnerId;

                console.log(`[Game ${gameId}] 🏆 Winner declared:`, winnerId.slice(0, 8));

                // ✅ Mark game as ended
                game.ended = true;
                game.endedAt = Date.now();
                game.winner = winnerId;
                game.phase = 'ended';

                broadcast(gameId, {
                    type: 'winner',
                    winnerId,
                    prizeAmount: game.prizeAmount
                });

                broadcast(gameId, {
                    type: 'game_phase_change',
                    phase: 'ended'
                });

                broadcast(gameId, {
                    type: 'game_ended',
                    winnerId,
                    prizeAmount: game.prizeAmount,
                    endedAt: game.endedAt
                });

                // ✅ Send confirmation
                ws.send(JSON.stringify({
                    type: 'winner_confirmed',
                    winnerId,
                    prizeAmount: game.prizeAmount,
                    timestamp: Date.now()
                }));

                console.log(`[Game ${gameId}] ✅ Game marked as ENDED`);
            }

        } catch (error: unknown) {
            console.error('[WebSocket] ❌ Error processing message:', error);
        }
    });

    ws.on('close', () => {
        if (playerId && gameId) {
            console.log(`[WebSocket] 🔌 Player disconnected: ${playerId.slice(0, 8)} from game ${gameId}`);

            clients.delete(playerId);

            const game = games.get(gameId);

            // ✅ Don't broadcast disconnection if game has ended
            if (game && !game.ended) {
                broadcast(gameId, {
                    type: 'player_disconnected',
                    playerId
                });

                const player = game.players.get(playerId);
                if (player) {
                    console.log(`[Game ${gameId}] ⚠️ Player ${playerId.slice(0, 8)} disconnected but kept in game`);
                }
            }
        }
    });

    ws.on('error', (error: Error) => {
        console.error('[WebSocket] ❌ Error:', error);
    });
});

// ==================== HEARTBEAT ====================

const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
        const extWs = ws as WebSocket & { isAlive?: boolean };

        if (extWs.isAlive === false) {
            return ws.terminate();
        }

        extWs.isAlive = false;
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

    return res.json({
        gameId: game.gameId,
        phase: game.phase,
        ended: game.ended, // ✅ NEW
        winner: game.winner,
        prizeAmount: game.prizeAmount, // ✅ NEW
        players: Array.from(game.players.values()).map(p => ({
            id: p.id,
            alive: p.alive,
            hp: p.hp,
            x: p.x,
            y: p.y
        })),
        readyPlayers: Array.from(game.readyPlayers),
        safeZoneRadius: game.safeZoneRadius
    });
});

app.get('/api/games', (req, res) => {
    const gamesList = Array.from(games.values()).map(game => ({
        gameId: game.gameId,
        phase: game.phase,
        ended: game.ended, // ✅ NEW
        playerCount: game.players.size,
        readyCount: game.readyPlayers.size,
        winner: game.winner,
        prizeAmount: game.prizeAmount // ✅ NEW
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
║   🔄 Game state sync: Every 1 second                  ║
║   🏆 Winner declaration: ENABLED                      ║
║   🛡️  Game ended protection: ENABLED                  ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
    `);
});

export { wss, games };