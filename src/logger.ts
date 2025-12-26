import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get the current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Base logs directory
const logsBaseDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsBaseDir)) {
  fs.mkdirSync(logsBaseDir, { recursive: true });
}

export interface RequestLogData {
  timestamp: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: any;
  query?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string; // Optional: will be auto-generated if not provided
}

export interface ResponseLogData {
  timestamp: string;
  status: number;
  responseTime: number;
  body?: any;
  headers?: Record<string, string>;
  error?: string;
  requestId?: string; // Optional: used to correlate with request
}

export interface GeneralLogData {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  data?: any;
}

/**
 * Get folder path based on current time
 * Format: logs/YYYY-MM-DD-HH/
 */
function getLogFolderPath(date?: Date): string {
  const now = date || new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');

  // Create folder: YYYY-MM-DD-HH
  const folderName = `${year}-${month}-${day}-${hour}`;
  const folderPath = path.join(logsBaseDir, folderName);

  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  return folderPath;
}

/**
 * Generate unique request ID
 */
function generateRequestId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 9);
  return `${timestamp}-${random}`;
}

/**
 * Get precise timestamp string for filename
 * Format: MM-SS-MMMMMM (minute-second-microsecond)
 */
function getPreciseTimestamp(date?: Date): string {
  const now = date || new Date();
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  const millisecond = String(now.getMilliseconds()).padStart(3, '0');

  // Add microseconds (simulated with random digits since JS doesn't have true microsecond precision)
  const microseconds = String(Math.floor(Math.random() * 1000)).padStart(3, '0');

  return `${minute}-${second}-${millisecond}${microseconds}`;
}

/**
 * Check if data is JSON-serializable and determine file extension
 */
function getFileExtension(data: any): 'json' | 'txt' {
  if (data === null || data === undefined) {
    return 'txt';
  }

  // If it's already a string, check if it's valid JSON
  if (typeof data === 'string') {
    try {
      JSON.parse(data);
      return 'json';
    } catch {
      return 'txt';
    }
  }

  // If it's an object, it's JSON-serializable
  if (typeof data === 'object') {
    return 'json';
  }

  return 'txt';
}

/**
 * Format data for writing to file
 */
function formatData(data: any, extension: 'json' | 'txt'): string {
  if (extension === 'json') {
    return JSON.stringify(data, null, 2);
  } else {
    if (typeof data === 'string') {
      return data;
    }
    return String(data);
  }
}

/**
 * Write request log
 * Filename: {requestId}_req.json or .txt
 * Returns: requestId for correlating with response
 */
export function writeRequestLog(data: RequestLogData): string {
  try {
    const timestamp = new Date(data.timestamp);
    const folderPath = getLogFolderPath(timestamp);
    const requestId = data.requestId || generateRequestId();
    const extension = getFileExtension(data);

    const fileName = `${requestId}_req.${extension}`;
    const filePath = path.join(folderPath, fileName);

    const content = formatData(data, extension);
    fs.writeFileSync(filePath, content, 'utf8');

    return requestId;
  } catch (error) {
    console.error('Failed to write request log:', error);
    return '';
  }
}

/**
 * Write response log
 * Filename: {requestId}_res.json or .txt
 * Returns: requestId for reference
 */
export function writeResponseLog(data: ResponseLogData): string {
  try {
    const timestamp = new Date(data.timestamp);
    const folderPath = getLogFolderPath(timestamp);
    const requestId = data.requestId || generateRequestId();
    const extension = getFileExtension(data);

    const fileName = `${requestId}_res.${extension}`;
    const filePath = path.join(folderPath, fileName);

    const content = formatData(data, extension);
    fs.writeFileSync(filePath, content, 'utf8');

    return requestId;
  } catch (error) {
    console.error('Failed to write response log:', error);
    return '';
  }
}

/**
 * Write general log
 * Filename: MM.log (appends to file for the current minute)
 */
export function writeGeneralLog(data: GeneralLogData): string {
  try {
    const timestamp = new Date(data.timestamp);
    const folderPath = getLogFolderPath(timestamp);
    const minute = String(timestamp.getMinutes()).padStart(2, '0');

    const fileName = `${minute}.log`;
    const filePath = path.join(folderPath, fileName);

    const logLine = `[${data.timestamp}] [${data.level.toUpperCase()}] ${data.message}${
      data.data ? '\n' + JSON.stringify(data.data, null, 2) : ''
    }\n${'='.repeat(80)}\n`;

    fs.appendFileSync(filePath, logLine, 'utf8');

    return filePath;
  } catch (error) {
    console.error('Failed to write general log:', error);
    return '';
  }
}

/**
 * Legacy function for backward compatibility
 * Now writes as general log
 */
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
  responseBody?: any;
  error?: string;
}

export function writeLog(entry: RequestLogEntry): void {
  const generalLogData: GeneralLogData = {
    timestamp: entry.timestamp,
    level: entry.error ? 'error' : 'info',
    message: `${entry.method} ${entry.path} - Status: ${entry.responseStatus || 'N/A'} - Time: ${entry.responseTime || 0}ms`,
    data: entry,
  };

  writeGeneralLog(generalLogData);
}

/**
 * Get current log folder path
 */
export function getCurrentLogFilePath(): string {
  const folderPath = getLogFolderPath();
  const minute = String(new Date().getMinutes()).padStart(2, '0');
  return path.join(folderPath, `${minute}.log`);
}
