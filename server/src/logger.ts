/**
 * Structured logging for better observability
 */

interface LogContext {
  [key: string]: any;
}

class Logger {
  private context: LogContext = {};

  withContext(context: LogContext): Logger {
    const logger = new Logger();
    logger.context = { ...this.context, ...context };
    return logger;
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const logEntry: any = {
      timestamp,
      level,
      message,
      ...this.context,
    };

    if (data) {
      logEntry.data = data;
    }

    return JSON.stringify(logEntry);
  }

  info(message: string, data?: any): void {
    console.log(this.formatMessage('INFO', message, data));
  }

  warn(message: string, data?: any): void {
    console.warn(this.formatMessage('WARN', message, data));
  }

  error(message: string, data?: any): void {
    console.error(this.formatMessage('ERROR', message, data));
  }

  debug(message: string, data?: any): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(this.formatMessage('DEBUG', message, data));
    }
  }
}

// Singleton instances for different contexts
export const logger = new Logger();

export const apolloLogger = logger.withContext({ service: 'apollo' });
export const llmLogger = logger.withContext({ service: 'llm' });
export const leadLogger = logger.withContext({ service: 'lead' });
export const auraLogger = logger.withContext({ service: 'aura' });
