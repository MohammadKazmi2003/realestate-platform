type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel: LogLevel = (process.env.NEXT_PUBLIC_LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatMessage(level: LogLevel, message: string, data?: any): string {
  const timestamp = new Date().toISOString();
  const dataStr = data !== undefined ? ` ${typeof data === 'string' ? data : JSON.stringify(data)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${dataStr}`;
}

export const logger = {
  info: (message: string, data?: any) => {
    if (shouldLog('info')) console.log(formatMessage('info', message, data));
  },
  warn: (message: string, data?: any) => {
    if (shouldLog('warn')) console.warn(formatMessage('warn', message, data));
  },
  error: (message: string, data?: any) => {
    if (shouldLog('error')) console.error(formatMessage('error', message, data));
  },
  debug: (message: string, data?: any) => {
    if (shouldLog('debug')) console.debug(formatMessage('debug', message, data));
  },
  searchAnalytics: (query: string, totalResults: number, latencyMs: number) => {
    if (shouldLog('info')) {
      console.log(JSON.stringify({
        type: 'search_analytics',
        timestamp: new Date().toISOString(),
        query,
        totalResults,
        latencyMs,
      }));
    }
  },
};
