declare const wss: import("ws").Server<typeof import("ws"), typeof import("http").IncomingMessage>;
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
declare const games: Map<string, GameRoom>;
export { wss, games };
//# sourceMappingURL=game-server.d.ts.map