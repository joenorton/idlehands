import { watch, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { getEventsFilePath } from '../utils/logger.js';
import { parseEvent, type Event } from '../model/events.js';
import { broadcastEvent } from './websocket.js';

let watchHandle: ReturnType<typeof watch> | null = null;
let lastPosition = 0;
let buffer = '';
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 10;
const ERROR_RETRY_DELAY = 1000; // 1 second

export function startFileWatcher() {
  const eventsFile = getEventsFilePath();

  if (!existsSync(eventsFile)) {
    // File doesn't exist yet, wait for it
    const checkInterval = setInterval(() => {
      if (existsSync(eventsFile)) {
        clearInterval(checkInterval);
        initializeWatcher();
      }
    }, 1000);
    return;
  }

  initializeWatcher();
}

function initializeWatcher() {
  const eventsFile = getEventsFilePath();
  
  // Initialize position to end of file
  try {
    const stats = statSync(eventsFile);
    lastPosition = stats.size;
  } catch {
    lastPosition = 0;
  }

  watchHandle = watch(eventsFile, (eventType) => {
    if (eventType === 'change') {
      readNewEvents();
    }
  });
}

function readNewEvents() {
  const eventsFile = getEventsFilePath();
  
  if (!existsSync(eventsFile)) {
    return;
  }

  try {
    const stats = statSync(eventsFile);
    const currentSize = stats.size;

    if (currentSize <= lastPosition) {
      // File might have been rotated or truncated
      lastPosition = 0;
      buffer = '';
      return;
    }

    // Read new bytes
    const fd = openSync(eventsFile, 'r');
    const bufferSize = currentSize - lastPosition;
    const readBuffer = Buffer.alloc(bufferSize);
    readSync(fd, readBuffer, 0, bufferSize, lastPosition);
    closeSync(fd);

    const newContent = readBuffer.toString('utf-8');
    buffer += newContent;
    lastPosition = currentSize;

    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        const event = parseEvent(line);
        if (event) {
          const clientsCount = broadcastEvent(event);
          console.log(`[${new Date().toISOString()}] 📡 File watcher: broadcast ${event.type} to ${clientsCount} client(s)`);
        }
      }
    }
    
    // Reset error counter on successful read
    resetErrorCounter();
  } catch (error) {
    consecutiveErrors++;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    // Log error with context
    console.error(`[${new Date().toISOString()}] ❌ File watcher error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, errorMessage);
    if (errorStack && consecutiveErrors <= 3) {
      // Only log stack trace for first few errors to avoid spam
      console.error(`[${new Date().toISOString()}] Stack:`, errorStack);
    }
    
    // If too many consecutive errors, reset and try to reinitialize
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(`[${new Date().toISOString()}] ⚠️ Too many consecutive errors, resetting file watcher`);
      consecutiveErrors = 0;
      lastPosition = 0;
      buffer = '';
      
      // Try to reinitialize after a delay
      setTimeout(() => {
        const eventsFile = getEventsFilePath();
        if (existsSync(eventsFile)) {
          try {
            initializeWatcher();
            console.log(`[${new Date().toISOString()}] ✅ File watcher reinitialized`);
          } catch (initError) {
            console.error(`[${new Date().toISOString()}] ❌ Failed to reinitialize file watcher:`, initError);
          }
        }
      }, ERROR_RETRY_DELAY * 5); // Wait 5 seconds before retry
    } else {
      // Reset position on transient errors (file might be locked)
      // Try again on next change event
      lastPosition = 0;
      buffer = '';
    }
  }
}

// Reset error counter on successful read
function resetErrorCounter() {
  if (consecutiveErrors > 0) {
    consecutiveErrors = 0;
  }
}
