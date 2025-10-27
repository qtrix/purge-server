// src/utils/Vector2D.ts - 2D Vector Math Utilities

import { Vector2D } from '../types';

export class Vec2 {
    /**
     * Calculate distance between two points
     */
    static distance(a: Vector2D, b: Vector2D): number {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Calculate squared distance (faster, no sqrt)
     */
    static distanceSquared(a: Vector2D, b: Vector2D): number {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        return dx * dx + dy * dy;
    }

    /**
     * Get length/magnitude of vector
     */
    static length(v: Vector2D): number {
        return Math.sqrt(v.x * v.x + v.y * v.y);
    }

    /**
     * Normalize vector to unit length
     */
    static normalize(v: Vector2D): Vector2D {
        const len = Vec2.length(v);
        if (len === 0) return { x: 0, y: 0 };
        return {
            x: v.x / len,
            y: v.y / len
        };
    }

    /**
     * Add two vectors
     */
    static add(a: Vector2D, b: Vector2D): Vector2D {
        return {
            x: a.x + b.x,
            y: a.y + b.y
        };
    }

    /**
     * Subtract two vectors
     */
    static subtract(a: Vector2D, b: Vector2D): Vector2D {
        return {
            x: a.x - b.x,
            y: a.y - b.y
        };
    }

    /**
     * Multiply vector by scalar
     */
    static multiply(v: Vector2D, scalar: number): Vector2D {
        return {
            x: v.x * scalar,
            y: v.y * scalar
        };
    }

    /**
     * Dot product
     */
    static dot(a: Vector2D, b: Vector2D): number {
        return a.x * b.x + a.y * b.y;
    }

    /**
     * Clamp vector to maximum length
     */
    static clampLength(v: Vector2D, maxLength: number): Vector2D {
        const len = Vec2.length(v);
        if (len > maxLength) {
            const scale = maxLength / len;
            return {
                x: v.x * scale,
                y: v.y * scale
            };
        }
        return v;
    }

    /**
     * Linear interpolation between two vectors
     */
    static lerp(a: Vector2D, b: Vector2D, t: number): Vector2D {
        return {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t
        };
    }

    /**
     * Rotate vector by angle (radians)
     */
    static rotate(v: Vector2D, angle: number): Vector2D {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return {
            x: v.x * cos - v.y * sin,
            y: v.x * sin + v.y * cos
        };
    }

    /**
     * Get angle between two vectors
     */
    static angle(a: Vector2D, b: Vector2D): number {
        return Math.atan2(b.y - a.y, b.x - a.x);
    }

    /**
     * Check if point is inside circle
     */
    static isInsideCircle(point: Vector2D, center: Vector2D, radius: number): boolean {
        return Vec2.distanceSquared(point, center) <= radius * radius;
    }

    /**
     * Get random point inside circle
     */
    static randomPointInCircle(center: Vector2D, radius: number): Vector2D {
        const angle = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * radius;
        return {
            x: center.x + r * Math.cos(angle),
            y: center.y + r * Math.sin(angle)
        };
    }

    /**
     * Clamp point to rectangle bounds
     */
    static clampToRect(point: Vector2D, width: number, height: number): Vector2D {
        return {
            x: Math.max(0, Math.min(width, point.x)),
            y: Math.max(0, Math.min(height, point.y))
        };
    }
}
