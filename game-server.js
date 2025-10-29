"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.games = exports.wss = void 0;
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const ws_1 = require("ws");
const cors_1 = __importDefault(require("cors"));
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const httpServer = (0, http_1.createServer)(app);
const wss = new ws_1.WebSocketServer({ server: httpServer });
exports.wss = wss;
const games = new Map();
exports.games = games;
const clients = new Map();
function broadcast(gameId, message, excludePlayerId) {
    clients.forEach((client) => {
        if (client.gameId === gameId && client.playerId !== excludePlayerId) {
            if (client.ws.readyState === ws_1.WebSocket.OPEN) {
                client.ws.send(JSON.stringify(message));
            }
        }
    });
}
function sendToPlayer(playerId, message) {
    const client = clients.get(playerId);
    if (client && client.ws.readyState === ws_1.WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
    }
}
function getOrCreateGame(gameId) {
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
    return games.get(gameId);
}
function getPlayersArray(game) {
    return Array.from(game.players.values());
}
function checkForWinner(game) {
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
function startCountdown(game) {
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
function startGame(game) {
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
setInterval(() => {
    const now = Date.now();
    games.forEach((game) => {
        if (game.phase !== 'waiting' || !game.deadline)
            return;
        if (now >= game.deadline) {
            const readyCount = game.readyPlayers.size;
            const totalPlayers = game.players.size;
            console.log(`[Game ${game.gameId}] ⏰ Deadline reached! Ready: ${readyCount}/${totalPlayers}`);
            if (readyCount >= 2) {
                console.log(`[Game ${game.gameId}] 🚀 Starting countdown...`);
                startCountdown(game);
            }
            else if (readyCount === 1) {
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
            }
            else {
                console.log(`[Game ${game.gameId}] ⚠️ No players ready - extending deadline`);
                game.deadline = now + 3600000;
            }
        }
    });
}, 1000);
wss.on('connection', (ws) => {
    console.log('[WebSocket] 🔗 New connection');
    let playerId = null;
    let gameId = null;
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            const { type } = message;
            if (type === 'connect') {
                gameId = message.gameId;
                playerId = message.playerId;
                console.log(`[WebSocket] 👋 Player connecting: ${playerId.slice(0, 8)} to game ${gameId}`);
                clients.set(playerId, {
                    ws,
                    playerId,
                    gameId,
                    isAlive: true
                });
                const game = getOrCreateGame(gameId);
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
                    players: getPlayersArray(game)
                }));
                broadcast(gameId, {
                    type: 'player_connected',
                    playerId
                }, playerId);
                console.log(`[Game ${gameId}] ✅ Player ${playerId.slice(0, 8)} connected (${game.players.size} total)`);
            }
            else if (type === 'mark_ready') {
                if (!playerId || !gameId)
                    return;
                const game = games.get(gameId);
                if (!game) {
                    console.log(`[WebSocket] ❌ Game ${gameId} not found`);
                    return;
                }
                game.readyPlayers.add(playerId);
                console.log(`[Game ${gameId}] ✅ Player ${playerId.slice(0, 8)} marked ready (${game.readyPlayers.size}/${game.players.size})`);
                broadcast(gameId, {
                    type: 'player_ready',
                    playerId,
                    readyCount: game.readyPlayers.size,
                    totalPlayers: game.players.size
                });
                if (game.readyPlayers.size === game.players.size && game.players.size > 0) {
                    console.log(`[Game ${gameId}] 🎮 All players ready!`);
                }
            }
            else if (type === 'set_deadline') {
                if (!gameId)
                    return;
                const game = games.get(gameId);
                if (!game)
                    return;
                game.deadline = message.deadline;
                console.log(`[Game ${gameId}] ⏰ Deadline set to ${new Date(message.deadline).toISOString()}`);
            }
            else if (type === 'start_game') {
                if (!gameId)
                    return;
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
                }
                else if (readyCount === 1) {
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
                }
                else {
                    console.log(`[Game ${gameId}] ⚠️ Cannot start - not enough ready players`);
                }
            }
            else if (type === 'update') {
                if (!playerId || !gameId)
                    return;
                const game = games.get(gameId);
                if (!game)
                    return;
                const player = game.players.get(playerId);
                if (!player)
                    return;
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
            else if (type === 'eliminated') {
                if (!playerId || !gameId)
                    return;
                const game = games.get(gameId);
                if (!game)
                    return;
                const player = game.players.get(playerId);
                if (!player)
                    return;
                player.alive = false;
                console.log(`[Game ${gameId}] 💀 Player eliminated:`, playerId.slice(0, 8));
                broadcast(gameId, {
                    type: 'eliminated',
                    playerId
                });
                checkForWinner(game);
            }
            else if (type === 'winner') {
                if (!gameId)
                    return;
                const game = games.get(gameId);
                if (!game)
                    return;
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
        }
        catch (error) {
            console.error('[WebSocket] ❌ Error processing message:', error);
        }
    });
    ws.on('close', () => {
        if (playerId && gameId) {
            console.log(`[WebSocket] 🔌 Player disconnected: ${playerId.slice(0, 8)} from game ${gameId}`);
            clients.delete(playerId);
            broadcast(gameId, {
                type: 'player_disconnected',
                playerId
            });
            const game = games.get(gameId);
            if (game) {
                const player = game.players.get(playerId);
                if (player) {
                    console.log(`[Game ${gameId}] ⚠️ Player ${playerId.slice(0, 8)} disconnected but kept in game`);
                }
            }
        }
    });
    ws.on('error', (error) => {
        console.error('[WebSocket] ❌ Error:', error);
    });
});
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        const extWs = ws;
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
    }
    else {
        res.status(404).json({ error: 'Game not found' });
    }
});
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
//# sourceMappingURL=game-server.js.map