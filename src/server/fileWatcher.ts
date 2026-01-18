import { watch, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { getEventsFilePath } from '../utils/logger.js';
import { parseEvent, type Event } from '../model/events.js';
import { broadcastEvent } from './websocket.js';

let watchHandle: ReturnType<typeof watch> | null = null;
let lastPosition = 0;
let buffer = '';

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
  } catch (error) {
    // Ignore errors, file might be locked or deleted
  }
}
