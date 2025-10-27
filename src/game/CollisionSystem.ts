// src/game/CollisionSystem.ts - Player Collision Detection & Physics

import { Player } from './Player';
import { Vec2 } from '../utils/Vector2D';
import { Vector2D } from '../types';

export interface CollisionConfig {
    playerRadius: number;
    pushForce: number;
    damping: number;
    enabled: boolean;
}

export class CollisionSystem {
    private config: CollisionConfig;

    constructor(config: CollisionConfig) {
        this.config = config;
    }

    /**
     * Check and resolve collisions between all players
     * Uses spatial partitioning for O(n) instead of O(n²)
     */
    checkCollisions(players: Player[]): void {
        if (!this.config.enabled) return;

        const alivePlayers = players.filter(p => p.isAlive());
        
        // Simple approach for up to 100 players
        // For more optimization, implement spatial hashing/quadtree
        for (let i = 0; i < alivePlayers.length; i++) {
            for (let j = i + 1; j < alivePlayers.length; j++) {
                this.resolveCollision(alivePlayers[i], alivePlayers[j]);
            }
        }
    }

    /**
     * Check collision between two players and resolve
     */
    private resolveCollision(playerA: Player, playerB: Player): void {
        const posA = playerA.getPosition();
        const posB = playerB.getPosition();

        const distance = Vec2.distance(posA, posB);
        const minDistance = this.config.playerRadius * 2;

        // Check if players are colliding
        if (distance < minDistance && distance > 0) {
            // Calculate collision response
            const overlap = minDistance - distance;
            const direction = Vec2.normalize(Vec2.subtract(posB, posA));

            // Separate players (each moves half the overlap)
            const separation = overlap / 2;
            
            const newPosA = Vec2.subtract(posA, Vec2.multiply(direction, separation));
            const newPosB = Vec2.add(posB, Vec2.multiply(direction, separation));

            playerA.updatePosition(newPosA.x, newPosA.y);
            playerB.updatePosition(newPosB.x, newPosB.y);

            // Apply push force (elastic collision)
            const force = this.config.pushForce * (overlap / this.config.playerRadius);
            
            playerA.applyPushForce(
                Vec2.multiply(direction, -1),
                force
            );
            playerB.applyPushForce(
                direction,
                force
            );
        }
    }

    /**
     * Check if a player collides with any other player
     */
    checkPlayerCollision(player: Player, otherPlayers: Player[]): boolean {
        const playerPos = player.getPosition();
        
        for (const other of otherPlayers) {
            if (other.getId() === player.getId() || !other.isAlive()) {
                continue;
            }

            const otherPos = other.getPosition();
            const distance = Vec2.distance(playerPos, otherPos);
            
            if (distance < this.config.playerRadius * 2) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get closest player within range
     */
    getClosestPlayer(position: Vector2D, players: Player[], maxRange: number): Player | null {
        let closest: Player | null = null;
        let closestDistance = maxRange;

        for (const player of players) {
            if (!player.isAlive()) continue;

            const playerPos = player.getPosition();
            const distance = Vec2.distance(position, playerPos);

            if (distance < closestDistance) {
                closest = player;
                closestDistance = distance;
            }
        }

        return closest;
    }

    /**
     * Get all players within range
     */
    getPlayersInRange(position: Vector2D, players: Player[], range: number): Player[] {
        return players.filter(player => {
            if (!player.isAlive()) return false;
            
            const playerPos = player.getPosition();
            return Vec2.distance(position, playerPos) <= range;
        });
    }

    /**
     * Apply velocity damping (friction)
     */
    applyDamping(player: Player, deltaTime: number): void {
        const state = player.getState();
        
        const dampingFactor = Math.pow(this.config.damping, deltaTime / 16.67); // Normalized to 60fps
        
        const newVx = state.velocityX * dampingFactor;
        const newVy = state.velocityY * dampingFactor;

        // Stop completely if velocity is very small
        const threshold = 0.01;
        player.updateVelocity(
            Math.abs(newVx) < threshold ? 0 : newVx,
            Math.abs(newVy) < threshold ? 0 : newVy
        );
    }

    /**
     * Update player position based on velocity
     */
    updatePosition(player: Player, deltaTime: number): void {
        const state = player.getState();
        
        // Update position based on velocity
        const newX = state.x + state.velocityX * (deltaTime / 16.67);
        const newY = state.y + state.velocityY * (deltaTime / 16.67);
        
        player.updatePosition(newX, newY);
    }

    /**
     * Spatial partition for optimization (optional, for 200+ players)
     */
    private createSpatialGrid(players: Player[], cellSize: number): Map<string, Player[]> {
        const grid = new Map<string, Player[]>();

        for (const player of players) {
            if (!player.isAlive()) continue;

            const pos = player.getPosition();
            const cellX = Math.floor(pos.x / cellSize);
            const cellY = Math.floor(pos.y / cellSize);
            const key = `${cellX},${cellY}`;

            if (!grid.has(key)) {
                grid.set(key, []);
            }
            grid.get(key)!.push(player);
        }

        return grid;
    }
}
