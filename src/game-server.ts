import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());
const httpServer = createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

// ==================== TYPES ====================

interface Player {
    id: string;
    walletAddress: string;
    name: string;
    x: number;
    y: number;
    radius: number;
    color: string;
    speed: number;
    hasShield: boolean;
    hasSpeed: boolean;
    alive: boolean;
    hp: number;
    maxHp: number;
    vsolBalance: number;
    lastUpdate: number;
    disconnected: boolean;
    socketId: string;
}

interface SafeZone {
    x: number;
    y: number;
    radius: number;
    shrinkRate: number;
}

interface GameRoom {
    gameId: number;
    players: Map<string, Player>;
    safeZone: SafeZone;
    gameStartTime: number;
    gameActive: boolean;
    winner: string | null;
    maxGameTime: number;
    eliminated: number;
}

interface PowerUp {
    type: 'speed' | 'shield';
    cost: number;
    duration: number;
}

// ==================== GAME STATE ====================

const gameRooms = new Map<number, GameRoom>();

const CANVAS_WIDTH = 900;
const CANVAS_HEIGHT = 700;
const INITIAL_SAFE_ZONE_RADIUS = 300;
const SAFE_ZONE_SHRINK_RATE = 0.5; // pixels per second
const SAFE_ZONE_DAMAGE = 2; // HP per second outside safe zone
const MAX_GAME_TIME = 600; // 10 minutes max
const PLAYER_COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
    '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B739', '#52BE80'
];

// ==================== HELPER FUNCTIONS ====================

function getRandomSpawnPosition(safeZone: SafeZone): { x: number; y: number } {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * (safeZone.radius - 50);
    return {
        x: safeZone.x + Math.cos(angle) * distance,
        y: safeZone.y + Math.sin(angle) * distance,
    };
}

function checkCollision(p1: Player, p2: Player): boolean {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance < (p1.radius + p2.radius);
}

function isOutsideSafeZone(player: Player, safeZone: SafeZone): boolean {
    const dx = player.x - safeZone.x;
    const dy = player.y - safeZone.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance > safeZone.radius - player.radius;
}

function pushPlayer(pusher: Player, pushed: Player) {
    const dx = pushed.x - pusher.x;
    const dy = pushed.y - pusher.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance === 0) return;

    const pushForce = 3;
    pushed.x += (dx / distance) * pushForce;
    pushed.y += (dy / distance) * pushForce;

    // Keep in canvas bounds
    pushed.x = Math.max(pushed.radius, Math.min(CANVAS_WIDTH - pushed.radius, pushed.x));
    pushed.y = Math.max(pushed.radius, Math.min(CANVAS_HEIGHT - pushed.radius, pushed.y));
}

// ==================== GAME LOOP ====================

function startGameLoop(gameId: number) {
    const room = gameRooms.get(gameId);
    if (!room) return;

    const UPDATE_INTERVAL = 50; // 20 FPS

    const gameLoop = setInterval(() => {
        if (!room.gameActive) {
            clearInterval(gameLoop);
            return;
        }

        const now = Date.now();
        const elapsedSeconds = (now - room.gameStartTime) / 1000;

        // Update safe zone (shrink over time)
        room.safeZone.radius = Math.max(
            50,
            INITIAL_SAFE_ZONE_RADIUS - (elapsedSeconds * room.safeZone.shrinkRate)
        );

        // Update all players
        const alivePlayers: Player[] = [];
        room.players.forEach((player) => {
            if (!player.alive) return;

            // Damage players outside safe zone
            if (isOutsideSafeZone(player, room.safeZone)) {
                player.hp -= SAFE_ZONE_DAMAGE * (UPDATE_INTERVAL / 1000);

                if (player.hp <= 0) {
                    player.alive = false;
                    player.hp = 0;
                    room.eliminated++;

                    io.to(`game-${gameId}`).emit('player-eliminated', {
                        walletAddress: player.walletAddress,
                        name: player.name,
                    });
                }
            }

            if (player.alive) {
                alivePlayers.push(player);
            }
        });

        // Check collisions and push players
        for (let i = 0; i < alivePlayers.length; i++) {
            for (let j = i + 1; j < alivePlayers.length; j++) {
                if (checkCollision(alivePlayers[i], alivePlayers[j])) {
                    pushPlayer(alivePlayers[i], alivePlayers[j]);
                    pushPlayer(alivePlayers[j], alivePlayers[i]);
                }
            }
        }

        // Check for winner
        if (alivePlayers.length === 1) {
            const winner = alivePlayers[0];
            room.winner = winner.walletAddress;
            room.gameActive = false;

            io.to(`game-${gameId}`).emit('game-over', {
                winner: winner.walletAddress,
                winnerName: winner.name,
                survivedPlayers: 1,
            });

            clearInterval(gameLoop);
            return;
        }

        // Check for time limit
        if (elapsedSeconds >= MAX_GAME_TIME && alivePlayers.length > 1) {
            // If multiple survivors at time limit, random winner
            const randomWinner = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
            room.winner = randomWinner.walletAddress;
            room.gameActive = false;

            io.to(`game-${gameId}`).emit('game-over', {
                winner: randomWinner.walletAddress,
                winnerName: randomWinner.name,
                survivedPlayers: alivePlayers.length,
            });

            clearInterval(gameLoop);
            return;
        }

        // Broadcast game state to all clients
        const gameState = {
            players: Array.from(room.players.values()).map(p => ({
                walletAddress: p.walletAddress,
                name: p.name,
                x: p.x,
                y: p.y,
                radius: p.radius,
                color: p.color,
                hp: p.hp,
                maxHp: p.maxHp,
                alive: p.alive,
                hasShield: p.hasShield,
                hasSpeed: p.hasSpeed,
                disconnected: p.disconnected,
            })),
            safeZone: room.safeZone,
            eliminated: room.eliminated,
            elapsedTime: Math.floor(elapsedSeconds),
        };

        io.to(`game-${gameId}`).emit('game-state', gameState);
    }, UPDATE_INTERVAL);
}

// ==================== SOCKET.IO HANDLERS ====================

io.on('connection', (socket: Socket) => {
    console.log(`🔗 Player connected: ${socket.id}`);

    // Join game lobby
    socket.on('join-lobby', ({ gameId, walletAddress, name }) => {
        console.log(`👋 ${name} (${walletAddress}) joined lobby ${gameId}`);
        socket.join(`lobby-${gameId}`);

        socket.emit('lobby-joined', { success: true });
    });

    // Start game (called by any player after countdown)
    socket.on('start-game', ({ gameId, readyPlayers }) => {
        console.log(`🎮 Starting game ${gameId} with ${readyPlayers.length} players`);

        if (gameRooms.has(gameId)) {
            socket.emit('error', { message: 'Game already started' });
            return;
        }

        // Create game room
        const room: GameRoom = {
            gameId,
            players: new Map(),
            safeZone: {
                x: CANVAS_WIDTH / 2,
                y: CANVAS_HEIGHT / 2,
                radius: INITIAL_SAFE_ZONE_RADIUS,
                shrinkRate: SAFE_ZONE_SHRINK_RATE,
            },
            gameStartTime: Date.now(),
            gameActive: true,
            winner: null,
            maxGameTime: MAX_GAME_TIME,
            eliminated: 0,
        };

        // Initialize players
        readyPlayers.forEach((playerData: any, index: number) => {
            const spawnPos = getRandomSpawnPosition(room.safeZone);
            const player: Player = {
                id: playerData.walletAddress,
                walletAddress: playerData.walletAddress,
                name: playerData.name,
                x: spawnPos.x,
                y: spawnPos.y,
                radius: 15,
                color: PLAYER_COLORS[index % PLAYER_COLORS.length],
                speed: 3,
                hasShield: false,
                hasSpeed: false,
                alive: true,
                hp: 100,
                maxHp: 100,
                vsolBalance: playerData.vsolBalance,
                lastUpdate: Date.now(),
                disconnected: false,
                socketId: '',
            };
            room.players.set(playerData.walletAddress, player);
        });

        gameRooms.set(gameId, room);

        // Notify all lobby members to enter game
        io.to(`lobby-${gameId}`).emit('game-started', { gameId });

        // Start game loop
        startGameLoop(gameId);
    });

    // Join active game
    socket.on('join-game', ({ gameId, walletAddress, name }) => {
        console.log(`🎮 ${name} joining game ${gameId}`);

        const room = gameRooms.get(gameId);
        if (!room) {
            socket.emit('error', { message: 'Game not found' });
            return;
        }

        const player = room.players.get(walletAddress);
        if (!player) {
            socket.emit('error', { message: 'Player not in this game' });
            return;
        }

        // Reconnection handling
        if (player.disconnected) {
            console.log(`🔄 ${name} reconnected to game ${gameId}`);
            player.disconnected = false;
        }

        player.socketId = socket.id;
        socket.join(`game-${gameId}`);

        // Send initial game state
        socket.emit('game-joined', {
            success: true,
            yourPlayer: {
                walletAddress: player.walletAddress,
                x: player.x,
                y: player.y,
            },
            gameState: {
                players: Array.from(room.players.values()).map(p => ({
                    walletAddress: p.walletAddress,
                    name: p.name,
                    x: p.x,
                    y: p.y,
                    radius: p.radius,
                    color: p.color,
                    hp: p.hp,
                    maxHp: p.maxHp,
                    alive: p.alive,
                    hasShield: p.hasShield,
                    hasSpeed: p.hasSpeed,
                    disconnected: p.disconnected,
                })),
                safeZone: room.safeZone,
            },
        });
    });

    // Player movement
    socket.on('player-move', ({ gameId, walletAddress, targetX, targetY }) => {
        const room = gameRooms.get(gameId);
        if (!room || !room.gameActive) return;

        const player = room.players.get(walletAddress);
        if (!player || !player.alive) return;

        // Move player towards target
        const dx = targetX - player.x;
        const dy = targetY - player.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > 1) {
            const speed = player.hasSpeed ? player.speed * 1.5 : player.speed;
            player.x += (dx / distance) * speed;
            player.y += (dy / distance) * speed;

            // Keep in canvas bounds
            player.x = Math.max(player.radius, Math.min(CANVAS_WIDTH - player.radius, player.x));
            player.y = Math.max(player.radius, Math.min(CANVAS_HEIGHT - player.radius, player.y));

            player.lastUpdate = Date.now();
        }
    });

    // Buy power-up
    socket.on('buy-powerup', ({ gameId, walletAddress, type }) => {
        const room = gameRooms.get(gameId);
        if (!room || !room.gameActive) return;

        const player = room.players.get(walletAddress);
        if (!player || !player.alive) return;

        let cost = 0;
        let duration = 0;

        if (type === 'speed') {
            cost = 100;
            duration = 10000; // 10 seconds
            if (player.vsolBalance >= cost && !player.hasSpeed) {
                player.vsolBalance -= cost;
                player.hasSpeed = true;

                setTimeout(() => {
                    player.hasSpeed = false;
                }, duration);

                socket.emit('powerup-activated', { type: 'speed', duration: duration / 1000 });
            }
        } else if (type === 'shield') {
            cost = 150;
            duration = 8000; // 8 seconds
            if (player.vsolBalance >= cost && !player.hasShield) {
                player.vsolBalance -= cost;
                player.hasShield = true;

                setTimeout(() => {
                    player.hasShield = false;
                }, duration);

                socket.emit('powerup-activated', { type: 'shield', duration: duration / 1000 });
            }
        } else if (type === 'health') {
            cost = 1;
            if (player.vsolBalance >= cost && player.hp < player.maxHp) {
                player.vsolBalance -= cost;
                player.hp = Math.min(player.maxHp, player.hp + 10);

                socket.emit('powerup-activated', { type: 'health' });
            }
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`🔌 Player disconnected: ${socket.id}`);

        // Mark player as disconnected but keep them in game
        gameRooms.forEach((room) => {
            room.players.forEach((player) => {
                if (player.socketId === socket.id) {
                    player.disconnected = true;
                    console.log(`⚠️ ${player.name} disconnected from game ${room.gameId}`);
                }
            });
        });
    });
});

// ==================== REST API ====================

app.get('/health', (req, res) => {
    res.json({ status: 'ok', games: gameRooms.size });
});

app.get('/game/:gameId', (req, res) => {
    const gameId = parseInt(req.params.gameId);
    const room = gameRooms.get(gameId);

    if (!room) {
        return res.status(404).json({ error: 'Game not found' });
    }

    res.json({
        gameId: room.gameId,
        gameActive: room.gameActive,
        winner: room.winner,
        players: Array.from(room.players.values()).map(p => ({
            walletAddress: p.walletAddress,
            name: p.name,
            alive: p.alive,
            hp: p.hp,
            disconnected: p.disconnected,
        })),
        eliminated: room.eliminated,
    });
});


// ==================== START SERVER ====================

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
    console.log(`🚀 Game server running on port ${PORT}`);
    console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
});

export { io, gameRooms };