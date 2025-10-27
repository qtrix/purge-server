// src/index.ts - Main Server Entry Point

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from './server/WebSocketServer';
import { logger } from './utils/Logger';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3001;
const app = express();

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
}));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Stats endpoint
let wsServer: WebSocketServer;

app.get('/stats', (req, res) => {
    if (!wsServer) {
        res.status(503).json({ error: 'Server not ready' });
        return;
    }

    res.json(wsServer.getStats());
});

// Create HTTP server
const server = createServer(app);

// Initialize WebSocket server
wsServer = new WebSocketServer(server);

// Graceful shutdown
const shutdown = () => {
    logger.info('Shutting down server...');
    
    wsServer.shutdown();
    
    server.close(() => {
        logger.info('Server shut down successfully');
        process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
server.listen(PORT, () => {
    logger.info('🚀 Purge Game Server started', {
        port: PORT,
        env: process.env.NODE_ENV || 'development',
        wsPath: '/game'
    });
    
    logger.info('Server ready to accept connections', {
        http: `http://localhost:${PORT}`,
        ws: `ws://localhost:${PORT}/game`
    });
});

// Error handling
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', { reason, promise });
});
