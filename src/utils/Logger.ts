// src/utils/Logger.ts - Structured Logging System

enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

class Logger {
    private level: LogLevel;
    private prefix: string;

    constructor(prefix: string = '', level: LogLevel = LogLevel.INFO) {
        this.prefix = prefix;
        this.level = level;
    }

    private format(level: string, message: string, data?: any): string {
        const timestamp = new Date().toISOString();
        const prefix = this.prefix ? `[${this.prefix}]` : '';
        let output = `${timestamp} ${level} ${prefix} ${message}`;
        
        if (data) {
            output += ` ${JSON.stringify(data)}`;
        }
        
        return output;
    }

    debug(message: string, data?: any) {
        if (this.level <= LogLevel.DEBUG) {
            console.log(this.format('DEBUG', message, data));
        }
    }

    info(message: string, data?: any) {
        if (this.level <= LogLevel.INFO) {
            console.log(this.format('INFO', message, data));
        }
    }

    warn(message: string, data?: any) {
        if (this.level <= LogLevel.WARN) {
            console.warn(this.format('WARN', message, data));
        }
    }

    error(message: string, data?: any) {
        if (this.level <= LogLevel.ERROR) {
            console.error(this.format('ERROR', message, data));
        }
    }

    child(prefix: string): Logger {
        return new Logger(`${this.prefix}:${prefix}`, this.level);
    }
}

export const logger = new Logger('PurgeServer');
export default Logger;
