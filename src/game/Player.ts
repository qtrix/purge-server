// src/game/Player.ts - Player Entity

import { PlayerState, Vector2D } from '../types';
import { Vec2 } from '../utils/Vector2D';

export class Player {
    private state: PlayerState;

    constructor(
        id: string,
        walletAddress: string,
        spawnPosition: Vector2D,
        vsolBalance: number
    ) {
        this.state = {
            id,
            walletAddress,
            username: walletAddress.slice(0, 8),

            // Position
            x: spawnPosition.x,
            y: spawnPosition.y,
            velocityX: 0,
            velocityY: 0,
            rotation: 0,

            // Stats
            hp: 100,
            maxHp: 100,
            vsolBalance,
            score: 0,
            kills: 0,

            // Status
            ready: false,
            eliminated: false,
            isAlive: true,
            isInSafeZone: true,

            // Timestamps
            joinedAt: Date.now(),
            lastUpdate: Date.now()
        };
    }

    // Getters
    getId(): string {
        return this.state.id;
    }

    getWalletAddress(): string {
        return this.state.walletAddress;
    }

    getState(): PlayerState {
        return { ...this.state };
    }

    getPosition(): Vector2D {
        return { x: this.state.x, y: this.state.y };
    }

    isAlive(): boolean {
        return this.state.isAlive && !this.state.eliminated;
    }

    isReady(): boolean {
        return this.state.ready;
    }

    isEliminated(): boolean {
        return this.state.eliminated;
    }

    getHp(): number {
        return this.state.hp;
    }

    // Setters
    setReady(ready: boolean): void {
        this.state.ready = ready;
        this.state.lastUpdate = Date.now();
    }

    updatePosition(x: number, y: number): void {
        this.state.x = x;
        this.state.y = y;
        this.state.lastUpdate = Date.now();
    }

    updateVelocity(vx: number, vy: number): void {
        this.state.velocityX = vx;
        this.state.velocityY = vy;
    }

    updateRotation(rotation: number): void {
        this.state.rotation = rotation;
    }

    /**
     * Update from client state
     */
    updateFromClient(update: Partial<PlayerState>): void {
        // Only allow updating certain fields from client
        if (update.x !== undefined) this.state.x = update.x;
        if (update.y !== undefined) this.state.y = update.y;
        if (update.velocityX !== undefined) this.state.velocityX = update.velocityX;
        if (update.velocityY !== undefined) this.state.velocityY = update.velocityY;
        if (update.rotation !== undefined) this.state.rotation = update.rotation;

        this.state.lastUpdate = Date.now();
    }

    /**
     * Apply damage to player
     */
    takeDamage(amount: number): boolean {
        if (!this.state.isAlive) return false;

        this.state.hp = Math.max(0, this.state.hp - amount);
        this.state.lastUpdate = Date.now();

        if (this.state.hp <= 0) {
            this.eliminate();
            return true; // Player died
        }

        return false;
    }

    /**
     * Heal player
     */
    heal(amount: number): void {
        if (!this.state.isAlive) return;

        this.state.hp = Math.min(this.state.maxHp, this.state.hp + amount);
        this.state.lastUpdate = Date.now();
    }

    /**
     * Mark player as eliminated
     */
    eliminate(): void {
        this.state.eliminated = true;
        this.state.isAlive = false;
        this.state.hp = 0;
        this.state.eliminatedAt = Date.now();
        this.state.lastUpdate = Date.now();
    }

    /**
     * Add kill to player stats
     */
    addKill(): void {
        this.state.kills++;
        this.state.score += 100;
        this.state.lastUpdate = Date.now();
    }

    /**
     * Update safe zone status
     */
    updateSafeZoneStatus(isInSafeZone: boolean): void {
        this.state.isInSafeZone = isInSafeZone;
    }

    /**
     * Apply push force (collision with other player)
     */
    applyPushForce(direction: Vector2D, force: number): void {
        const normalized = Vec2.normalize(direction);
        this.state.velocityX += normalized.x * force;
        this.state.velocityY += normalized.y * force;
    }

    /**
     * Clamp position to bounds
     */
    clampPosition(width: number, height: number, margin: number = 0): void {
        this.state.x = Math.max(margin, Math.min(width - margin, this.state.x));
        this.state.y = Math.max(margin, Math.min(height - margin, this.state.y));
    }

    /**
     * Get survival time in seconds
     */
    getSurvivalTime(): number {
        const endTime = this.state.eliminatedAt || Date.now();
        return Math.floor((endTime - this.state.joinedAt) / 1000);
    }

    /**
     * Get serializable state for network sync
     */
    toJSON(): PlayerState {
        return this.getState();
    }
}
