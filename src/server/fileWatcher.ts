import { watch } from 'fs';
import { promises as fs } from 'fs';
import { getEventsFilePath } from '../utils/logger.js';
import { parseEvent, type Event } from '../model/events.js';
import { broadcastEvent } from './websocket.js';

const SOURCE = 'file_watcher';

// Single-flight queue state
let reading = false;
let dirty = false;
let lastOffset = 0; // File byte offset (line-start offset of last emitted event)
let carry = Buffer.alloc(0); // Partial line remainder from last read
let lastEmittedOffset = 0; // For monotonicity assertion
let seenEventIds = new Set<string>(); // For ID uniqueness assertion
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 10;
const ERROR_RETRY_DELAY = 1000;

let watchHandle: ReturnType<typeof watch> | null = null;
let watcherInstanceId: string | null = null; // Track watcher instance to detect double instantiation

export function startFileWatcher() {
  // Detect double watcher instantiation
  if (watchHandle !== null) {
    const existingId = watcherInstanceId || 'unknown';
    const newId = `watcher_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    console.error(`[FileWatcher] ⚠️ DOUBLE WATCHER DETECTED! Existing instance: ${existingId}, New instance: ${newId}`);
    console.error(`[FileWatcher] This will cause duplicate events! Check for hot reload, clustered node, or double-instantiated watcher module.`);
    // Don't start second watcher
    return;
  }
  
  watcherInstanceId = `watcher_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  console.log(`[FileWatcher] Starting file watcher instance: ${watcherInstanceId}`);
  const eventsFile = getEventsFilePath();

  // Check if file exists (async)
  fs.access(eventsFile)
    .then(() => {
      initializeWatcher();
    })
    .catch(() => {
      // File doesn't exist yet, wait for it
      const checkInterval = setInterval(() => {
        fs.access(eventsFile)
          .then(() => {
            clearInterval(checkInterval);
            initializeWatcher();
          })
          .catch(() => {
            // Still doesn't exist, keep waiting
          });
      }, 1000);
    });
}

async function initializeWatcher() {
  const eventsFile = getEventsFilePath();
  
  try {
    // Initialize position to end of file
    const stats = await fs.stat(eventsFile);
    lastOffset = stats.size;
    lastEmittedOffset = stats.size; // Start from EOF
    carry = Buffer.alloc(0);
  } catch {
    lastOffset = 0;
    lastEmittedOffset = 0;
    carry = Buffer.alloc(0);
  }

  watchHandle = watch(eventsFile, (eventType) => {
    if (eventType === 'change') {
      readNewEvents();
    }
  });
}

async function readNewEvents() {
  // Single-flight queue: if already reading, mark dirty and return
  if (reading) {
    dirty = true;
    return;
  }

  reading = true;
  const eventsFile = getEventsFilePath();
  
  try {
    // Check if file exists
    await fs.access(eventsFile);
  } catch {
    reading = false;
    if (dirty) {
      dirty = false;
      readNewEvents(); // Retry if marked dirty
    }
    return;
  }

  try {
    const stats = await fs.stat(eventsFile);
    const currentSize = stats.size;

    // Handle file truncation/rotation
    if (currentSize < lastOffset) {
      // File was truncated or rotated - reset state
      lastOffset = 0;
      lastEmittedOffset = 0;
      carry = Buffer.alloc(0);
      seenEventIds.clear();
      
      // Emit gap/reset marker
      const resetEvent: Event = {
        v: 1,
        ts: Date.now() / 1000,
        type: 'unknown',
        session_id: 'system',
        id: `${SOURCE}:${currentSize}`,
        payload_keys: [],
        reason: 'File truncated or rotated',
      };
      broadcastEvent(resetEvent);
      
      reading = false;
      if (dirty) {
        dirty = false;
        readNewEvents();
      }
      return;
    }

    if (currentSize <= lastOffset) {
      // No new data
      reading = false;
      if (dirty) {
        dirty = false;
        readNewEvents();
      }
      return;
    }

    // Read new bytes from lastOffset to EOF
    const fd = await fs.open(eventsFile, 'r');
    const readSize = currentSize - lastOffset;
    const readBuffer = Buffer.alloc(readSize);
    await fd.read(readBuffer, 0, readSize, lastOffset);
    await fd.close();

    // Prepend carry buffer to new read
    const combinedBuffer = Buffer.concat([carry, readBuffer]);
    
    // Find all complete lines (ending in \n)
    const lines: Array<{ line: Buffer; startOffset: number }> = [];
    let lineStart = 0;
    
    for (let i = 0; i < combinedBuffer.length; i++) {
      if (combinedBuffer[i] === 0x0A) { // \n
        // Found complete line
        const lineBuffer = combinedBuffer.slice(lineStart, i + 1);
        const lineStartOffset = lastOffset - carry.length + lineStart;
        lines.push({
          line: lineBuffer,
          startOffset: lineStartOffset
        });
        lineStart = i + 1;
      }
    }
    
    // Keep incomplete line in carry (from lineStart to end)
    carry = combinedBuffer.slice(lineStart);
    
    // Update lastOffset to the byte position after the last complete line
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      lastOffset = lastLine.startOffset + lastLine.line.length;
    } else {
      // No complete lines, lastOffset stays the same (we'll read from same position next time)
    }

    // Assert: carry must never contain a newline
    if (process.env.NODE_ENV === 'development') {
      if (carry.includes(0x0A)) {
        console.error(`[FileWatcher] CRITICAL: Carry buffer contains newline! Carry: ${carry.toString('hex')}`);
        throw new Error('Carry buffer contains newline - split logic broken');
      }
    }

    // Parse and emit events
    const events: Event[] = [];
    
    for (const { line, startOffset } of lines) {
      // Generate canonical event ID: source:lineStartOffset
      // Check for duplicates BEFORE parsing to avoid unnecessary work
      const eventId = `${SOURCE}:${startOffset}`;
      
      // Assert: ID uniqueness - check BEFORE parsing
      if (seenEventIds.has(eventId)) {
        console.error(`[FileWatcher] ⚠️ DUPLICATE DETECTED (before parse): event_id=${eventId}, offset=${startOffset}, seen_count=${seenEventIds.size} - SKIPPING`);
        // Skip this line entirely - don't parse or broadcast
        continue;
      }
      
      // Mark as seen IMMEDIATELY to prevent race conditions
      seenEventIds.add(eventId);
      
      // Decode to UTF-8 only once we have the exact line
      const lineText = line.toString('utf-8').trim();
      
      if (!lineText) {
        continue; // Skip empty lines
      }

      const event = parseEvent(lineText);
      if (!event) {
        // Remove from seen set if parsing failed (so we can retry later if needed)
        seenEventIds.delete(eventId);
        continue; // Skip invalid events
      }

      // Already marked as seen above, before parsing
      
      // Assert: Monotonicity - offsets must be strictly increasing
      if (process.env.NODE_ENV === 'development') {
        if (startOffset <= lastEmittedOffset) {
          console.error(`[FileWatcher] Offset regression: ${startOffset} <= ${lastEmittedOffset}`);
          throw new Error(`Monotonicity violation: ${startOffset} <= ${lastEmittedOffset}`);
        }
      }
      
      lastEmittedOffset = startOffset;
      
      // Add ID to event
      event.id = eventId;
      
      // Add temporary debug field to track ingestion path
      (event as any).ingest_path = 'watcher';
      
      events.push(event);
    }

    // Emit all events (watcher never drops - that's WS batcher's job)
    for (const event of events) {
      if (process.env.NODE_ENV === 'development') {
        console.log(`[FileWatcher] Broadcasting event: id=${event.id}, ingest_path=${(event as any).ingest_path}`);
      }
      const clientCount = broadcastEvent(event);
      if (clientCount === 0 && process.env.NODE_ENV === 'development') {
        console.warn(`[FileWatcher] Event broadcast returned 0 clients: id=${event.id}`);
      }
    }
    
    if (events.length > 0) {
      console.log(`[${new Date().toISOString()}] 📡 File watcher: emitted ${events.length} event(s) from offset ${lastOffset - readSize} to ${lastOffset}`);
    }
    
    // Reset error counter on successful read
    resetErrorCounter();
    
    reading = false;
    
    // If dirty flag was set during read, immediately re-read
    if (dirty) {
      dirty = false;
      readNewEvents();
    }
  } catch (error) {
    consecutiveErrors++;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    console.error(`[${new Date().toISOString()}] ❌ File watcher error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, errorMessage);
    if (errorStack && consecutiveErrors <= 3) {
      console.error(`[${new Date().toISOString()}] Stack:`, errorStack);
    }
    
    reading = false;
    
    // If too many consecutive errors, reset and try to reinitialize
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(`[${new Date().toISOString()}] ⚠️ Too many consecutive errors, resetting file watcher`);
      consecutiveErrors = 0;
      lastOffset = 0;
      lastEmittedOffset = 0;
      carry = Buffer.alloc(0);
      seenEventIds.clear();
      
      setTimeout(async () => {
        const eventsFile = getEventsFilePath();
        try {
          await fs.access(eventsFile);
          initializeWatcher();
          console.log(`[${new Date().toISOString()}] ✅ File watcher reinitialized`);
        } catch (initError) {
          console.error(`[${new Date().toISOString()}] ❌ Failed to reinitialize file watcher:`, initError);
        }
      }, ERROR_RETRY_DELAY * 5);
    } else {
      // Reset position on transient errors (file might be locked)
      lastOffset = 0;
      carry = Buffer.alloc(0);
    }
    
    // Retry if dirty
    if (dirty) {
      dirty = false;
      readNewEvents();
    }
  }
}

function resetErrorCounter() {
  if (consecutiveErrors > 0) {
    consecutiveErrors = 0;
  }
}

// Export stats for monitoring
export function getWatcherStats() {
  return {
    last_offset: lastOffset,
    carry_bytes: carry.length,
    seen_event_ids: seenEventIds.size,
    consecutive_errors: consecutiveErrors,
  };
}
