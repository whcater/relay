import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get the current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Log file path with timestamp
const logFileName = `requests_${new Date().toISOString().split('T')[0]}.txt`;
const logFilePath = path.join(logsDir, logFileName);

export interface RequestLogEntry {
  timestamp: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: any;
  query?: string;
  ip?: string;
  userAgent?: string;
  responseStatus?: number;
  responseTime?: number;
  error?: string;
}

/**
 * Write log entry to file
 */
export function writeLog(entry: RequestLogEntry): void {
  try {
    const logLine = formatLogEntry(entry);

    // Append to file with newline
    fs.appendFileSync(logFilePath, logLine + '\n\n', 'utf8');
  } catch (error) {
    console.error('Failed to write log:', error);
  }
}

/**
 * Format log entry for readable text output
 */
function formatLogEntry(entry: RequestLogEntry): string {
  const separator = '='.repeat(80);

  let logText = `${separator}\n`;
  logText += `[${entry.timestamp}] ${entry.method} ${entry.path}\n`;
  logText += `${separator}\n`;

  // Add query parameters if present
  if (entry.query) {
    logText += `Query: ${entry.query}\n`;
  }

  // Add relevant headers
  logText += `Headers:\n`;
  const importantHeaders = ['authorization', 'x-api-key', 'content-type', 'user-agent', 'origin'];
  for (const header of importantHeaders) {
    if (entry.headers[header]) {
      const value = header.includes('authorization') || header.includes('api-key')
        ? `${entry.headers[header].substring(0, 20)}...` // Mask sensitive data
        : entry.headers[header];
      logText += `  ${header}: ${value}\n`;
    }
  }

  // Add body if present (limited to 5000 chars to avoid huge logs)
  if (entry.body) {
    const bodyStr = typeof entry.body === 'string'
      ? entry.body
      : JSON.stringify(entry.body, null, 2);

    // if (bodyStr.length > 5000) {
    //   logText += `Body (truncated):\n${bodyStr.substring(0, 5000)}...\n`;
    // } else {
      logText += `Body:\n${bodyStr}\n`;
    // }
  }

  // Add response info if available
  if (entry.responseStatus !== undefined) {
    logText += `Response Status: ${entry.responseStatus}\n`;
  }

  if (entry.responseTime !== undefined) {
    logText += `Response Time: ${entry.responseTime}ms\n`;
  }

  if (entry.error) {
    logText += `Error: ${entry.error}\n`;
  }

  return logText;
}

/**
 * Get current log file path
 */
export function getCurrentLogFilePath(): string {
  return logFilePath;
}

/**
 * Get all log files
 */
export function getAllLogFiles(): string[] {
  try {
    const files = fs.readdirSync(logsDir);
    return files
      .filter(file => file.startsWith('requests_') && file.endsWith('.txt'))
      .map(file => path.join(logsDir, file));
  } catch (error) {
    console.error('Failed to read log files:', error);
    return [];
  }
}