// src/game/SafeZone.ts - Safe Zone Mechanics

import { SafeZoneState, Vector2D } from '../types';
import { Vec2 } from '../utils/Vector2D';
import { logger } from '../utils/Logger';

export class SafeZone {
    private state: SafeZoneState;
    private config: {
        initialRadius: number;
        minRadius: number;
        shrinkInterval: number;
        shrinkAmount: number;
        damagePerSecond: number;
    };
    private mapWidth: number;
    private mapHeight: number;
    private lastDamageTick: number;

    constructor(
        mapWidth: number,
        mapHeight: number,
        initialRadius: number,
        minRadius: number,
        shrinkInterval: number,
        damagePerSecond: number
    ) {
        this.mapWidth = mapWidth;
        this.mapHeight = mapHeight;
        this.lastDamageTick = Date.now();

        this.config = {
            initialRadius,
            minRadius,
            shrinkInterval,
            shrinkAmount: 50, // Reduce by 50 units each shrink
            damagePerSecond
        };

        // Start at map center
        this.state = {
            centerX: mapWidth / 2,
            centerY: mapHeight / 2,
            radius: initialRadius,
            targetRadius: initialRadius,
            shrinking: false,
            nextShrinkAt: Date.now() + shrinkInterval
        };

        logger.info('SafeZone initialized', {
            center: `(${this.state.centerX}, ${this.state.centerY})`,
            radius: this.state.radius,
            nextShrink: new Date(this.state.nextShrinkAt).toISOString()
        });
    }

    /**
     * Get current safe zone state
     */
    getState(): SafeZoneState {
        return { ...this.state };
    }

    /**
     * Get center position
     */
    getCenter(): Vector2D {
        return {
            x: this.state.centerX,
            y: this.state.centerY
        };
    }

    /**
     * Get current radius
     */
    getRadius(): number {
        return this.state.radius;
    }

    /**
     * Check if position is inside safe zone
     */
    isInside(position: Vector2D): boolean {
        return Vec2.isInsideCircle(
            position,
            this.getCenter(),
            this.state.radius
        );
    }

    /**
     * Get distance from safe zone edge (negative = outside)
     */
    getDistanceFromEdge(position: Vector2D): number {
        const distanceFromCenter = Vec2.distance(position, this.getCenter());
        return this.state.radius - distanceFromCenter;
    }

    /**
     * Update safe zone (called every game tick)
     */
    update(deltaTime: number): boolean {
        const now = Date.now();
        let hasChanged = false;

        // Check if it's time to shrink
        if (now >= this.state.nextShrinkAt && this.state.radius > this.config.minRadius) {
            this.startShrink();
            hasChanged = true;
        }

        // Animate shrinking
        if (this.state.shrinking) {
            const shrinkSpeed = 0.5; // Units per millisecond
            const shrinkAmount = shrinkSpeed * deltaTime;
            
            if (this.state.radius > this.state.targetRadius) {
                this.state.radius = Math.max(
                    this.state.targetRadius,
                    this.state.radius - shrinkAmount
                );
                hasChanged = true;
            } else {
                this.state.shrinking = false;
                this.state.nextShrinkAt = now + this.config.shrinkInterval;
                
                logger.info('SafeZone shrink complete', {
                    radius: this.state.radius,
                    nextShrink: new Date(this.state.nextShrinkAt).toISOString()
                });
            }
        }

        return hasChanged;
    }

    /**
     * Start shrinking to next radius
     */
    private startShrink(): void {
        const newTargetRadius = Math.max(
            this.config.minRadius,
            this.state.radius - this.config.shrinkAmount
        );

        this.state.targetRadius = newTargetRadius;
        this.state.shrinking = true;

        // Slightly move center towards a random direction
        const angle = Math.random() * Math.PI * 2;
        const moveDistance = 20;
        const newCenter = {
            x: this.state.centerX + Math.cos(angle) * moveDistance,
            y: this.state.centerY + Math.sin(angle) * moveDistance
        };

        // Clamp to map bounds
        this.state.centerX = Math.max(
            this.config.minRadius,
            Math.min(this.mapWidth - this.config.minRadius, newCenter.x)
        );
        this.state.centerY = Math.max(
            this.config.minRadius,
            Math.min(this.mapHeight - this.config.minRadius, newCenter.y)
        );

        logger.info('SafeZone shrinking', {
            from: this.state.radius,
            to: this.state.targetRadius,
            newCenter: `(${this.state.centerX}, ${this.state.centerY})`
        });
    }

    /**
     * Calculate damage for position outside safe zone
     */
    calculateDamage(deltaTime: number): number {
        const now = Date.now();
        const timeSinceLastDamage = now - this.lastDamageTick;

        if (timeSinceLastDamage >= 1000) {
            this.lastDamageTick = now;
            return this.config.damagePerSecond;
        }

        return 0;
    }

    /**
     * Force shrink (for testing or special events)
     */
    forceShrink(amount?: number): void {
        const shrinkAmount = amount || this.config.shrinkAmount;
        this.state.targetRadius = Math.max(
            this.config.minRadius,
            this.state.radius - shrinkAmount
        );
        this.state.shrinking = true;
    }

    /**
     * Reset safe zone to initial state
     */
    reset(): void {
        this.state.centerX = this.mapWidth / 2;
        this.state.centerY = this.mapHeight / 2;
        this.state.radius = this.config.initialRadius;
        this.state.targetRadius = this.config.initialRadius;
        this.state.shrinking = false;
        this.state.nextShrinkAt = Date.now() + this.config.shrinkInterval;
        this.lastDamageTick = Date.now();
    }

    /**
     * Get info for debugging
     */
    getDebugInfo(): any {
        return {
            center: `(${this.state.centerX.toFixed(1)}, ${this.state.centerY.toFixed(1)})`,
            radius: this.state.radius.toFixed(1),
            targetRadius: this.state.targetRadius.toFixed(1),
            shrinking: this.state.shrinking,
            nextShrinkIn: Math.max(0, this.state.nextShrinkAt - Date.now()),
            minRadiusReached: this.state.radius <= this.config.minRadius
        };
    }
}
