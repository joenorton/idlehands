import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Event, UnknownEvent } from '../model/events.js';

// Gap event type (extends UnknownEvent with gap-specific fields)
export interface GapEvent {
  v: number;
  ts: number;
  type: 'unknown';
  session_id: string;
  id?: string;
  payload_keys: string[];
  reason?: string;
  gap_type: 'dropped';
  dropped_count: number;
  from_event_id: string;
  to_offset: number;
}

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();
const clientIds = new Map<WebSocket, string>(); // Track client IDs for debugging

const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB limit for WebSocket messages

// Duplicate detection: track recent event IDs (5 second window to catch duplicates from file watcher races)
const recentEventIds = new Map<string, { timestamp: number; ingest_path?: string }>();
const DUPLICATE_WINDOW_MS = 5000; // 5 second window for duplicate detection (covers file watcher race conditions)

// Batching configuration
const BATCH_WINDOW_MS = 50; // 50ms batch window
const MAX_BATCH_SIZE = 100; // Max events per batch
const MAX_QUEUE_SIZE = 1000; // Backpressure threshold
const LEADING_EDGE = true; // Send first batch immediately

// Batching state
const queue: Event[] = [];
let batchTimer: NodeJS.Timeout | null = null;
let immediateScheduled = false;

// Backpressure state (global dropping for v0.x)
let droppedEventsTotal = 0;
let droppedEventsLast60s = 0;
const droppedEventsHistory: number[] = []; // Timestamps of dropped events for 60s window
let lastDeliveredEventId: string | null = null; // For gap watermark

// Stats
let batchesSent = 0;
let eventsSent = 0;
let lastBatchIdPerClient = new Map<WebSocket, string>(); // For cross-batch ordering check

export function setupWebSocket(server: Server) {
  wss = new WebSocketServer({ 
    server, 
    path: '/ws',
    maxPayload: MAX_MESSAGE_SIZE 
  });

  wss.on('connection', (ws: WebSocket) => {
    // Generate unique client ID for debugging
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    clients.add(ws);
    clientIds.set(ws, clientId);
    lastBatchIdPerClient.set(ws, ''); // Initialize
    console.log(`[${new Date().toISOString()}] 🔌 WebSocket client connected: ${clientId} (${clients.size} total)`);
    
    // Warn if multiple clients (potential double subscription)
    if (clients.size > 1) {
      console.warn(`[${new Date().toISOString()}] ⚠️ Multiple WebSocket clients detected (${clients.size} total) - possible double subscription`);
    }
    
    ws.on('close', () => {
      const id = clientIds.get(ws) || 'unknown';
      clients.delete(ws);
      clientIds.delete(ws);
      lastBatchIdPerClient.delete(ws);
      console.log(`[${new Date().toISOString()}] 🔌 WebSocket client disconnected: ${id} (${clients.size} remaining)`);
    });

    ws.on('error', (error) => {
      const id = clientIds.get(ws) || 'unknown';
      console.error(`[${new Date().toISOString()}] ❌ WebSocket error (${id}):`, error);
      clients.delete(ws);
      clientIds.delete(ws);
      lastBatchIdPerClient.delete(ws);
    });
  });

  // Clean up dropped events history every minute
  setInterval(() => {
    const now = Date.now();
    const cutoff = now - 60000; // 60 seconds
    while (droppedEventsHistory.length > 0 && droppedEventsHistory[0] < cutoff) {
      droppedEventsHistory.shift();
    }
    droppedEventsLast60s = droppedEventsHistory.length;
  }, 10000); // Check every 10 seconds
}

function compareEventIds(id1: string, id2: string): number {
  // Event IDs are "source:offset", so we can compare offsets
  const parts1 = id1.split(':');
  const parts2 = id2.split(':');
  if (parts1.length !== 2 || parts2.length !== 2) {
    return id1.localeCompare(id2); // Fallback to string compare
  }
  const offset1 = parseInt(parts1[1], 10);
  const offset2 = parseInt(parts2[1], 10);
  if (isNaN(offset1) || isNaN(offset2)) {
    return id1.localeCompare(id2);
  }
  return offset1 - offset2;
}

function flushBatch() {
  if (queue.length === 0) {
    return;
  }

  // Take batch from queue
  const batchSize = Math.min(queue.length, MAX_BATCH_SIZE);
  const batch = queue.splice(0, batchSize);
  batchTimer = null;
  immediateScheduled = false;

  // Assert: Batch ordering (dev builds only)
  if (process.env.NODE_ENV === 'development') {
    for (let i = 1; i < batch.length; i++) {
      const currId = batch[i].id;
      const prevId = batch[i-1].id;
      if (!currId || !prevId) continue;
      if (compareEventIds(currId, prevId) <= 0) {
        console.error(`[WebSocket] Batch ordering violation: ${currId} <= ${prevId}`);
      }
    }
  }

  const message = JSON.stringify({ type: 'batch', events: batch });
  
  // Log batch send with client info (dev only)
  if (process.env.NODE_ENV === 'development' && clients.size > 0) {
    const clientList = Array.from(clients).map(ws => clientIds.get(ws) || 'unknown').join(', ');
    console.log(`[WebSocket] Sending batch: ${batch.length} events to ${clients.size} client(s): [${clientList}]`);
    // Log event IDs for duplicate detection
    const eventIds = batch.map(e => e.id || 'no-id').join(', ');
    console.log(`[WebSocket] Batch event IDs: [${eventIds}]`);
  }
  let sentCount = 0;
  
  // Send to all clients
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
        sentCount++;
        
        // Track last batch ID per client for cross-batch ordering
        if (batch.length > 0 && batch[batch.length - 1].id) {
        const lastEvent = batch[batch.length - 1];
        if (lastEvent.id) {
          const lastId = lastEvent.id;
          const prevId = lastBatchIdPerClient.get(client) || '';
          if (prevId && process.env.NODE_ENV === 'development') {
            const firstId = batch[0].id || '';
            if (firstId && compareEventIds(firstId, prevId) <= 0) {
              console.error(`[WebSocket] Cross-batch ordering violation: ${firstId} <= ${prevId}`);
            }
          }
          lastBatchIdPerClient.set(client, lastId);
        }
        }
      } catch (error) {
        // Client buffer full - this is per-client backpressure
        // For v0.x we use global dropping, so this shouldn't happen often
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`[${new Date().toISOString()}] ⚠️ Failed to send batch to WebSocket client: ${errorMessage}`);
        clients.delete(client);
        lastBatchIdPerClient.delete(client);
      }
    }
  }
  
  if (sentCount > 0) {
    batchesSent++;
    eventsSent += batch.length;
    
    // Update last delivered event ID for gap watermark
    if (batch.length > 0 && batch[batch.length - 1].id) {
      lastDeliveredEventId = batch[batch.length - 1].id!;
    }
    
    console.log(`[${new Date().toISOString()}] 📡 WebSocket: sent batch of ${batch.length} event(s) to ${sentCount} client(s)`);
  }
  
  // If queue still has events, schedule next flush
  if (queue.length > 0) {
    if (queue.length >= MAX_BATCH_SIZE) {
      // Queue is full, flush immediately
      flushBatch();
    } else {
      // Schedule next flush
      batchTimer = setTimeout(() => {
        flushBatch();
      }, BATCH_WINDOW_MS);
    }
  }
}

export function broadcastEvent(event: Event): number {
  if (!wss) return 0;

  // Duplicate detection: prevent same event_id from being queued in 1s window
  if (event.id) {
    const now = Date.now();
    const existing = recentEventIds.get(event.id);
    if (existing) {
      const age = now - existing.timestamp;
      if (age < DUPLICATE_WINDOW_MS) {
        const ingestPath = (event as any).ingest_path || 'unknown';
        const existingPath = existing.ingest_path || 'unknown';
        console.error(`[WebSocket] ⚠️ DUPLICATE DETECTED: event_id=${event.id}, age=${age}ms, current_path=${ingestPath}, previous_path=${existingPath} - DROPPING`);
        // Actually prevent the duplicate from being queued
        return clients.size;
      }
    }
    // Update tracking (clean old entries)
    recentEventIds.set(event.id, { 
      timestamp: now, 
      ingest_path: (event as any).ingest_path 
    });
    // Cleanup old entries
    for (const [id, data] of recentEventIds.entries()) {
      if (now - data.timestamp > DUPLICATE_WINDOW_MS) {
        recentEventIds.delete(id);
      }
    }
  }

  // Add event to queue
  queue.push(event);

  // Check for backpressure (global dropping for v0.x)
  if (queue.length > MAX_QUEUE_SIZE) {
    // Client can't keep up - drop oldest events coherently
    const droppedCount = queue.length - MAX_QUEUE_SIZE;
    const droppedEvents = queue.splice(0, droppedCount);
    
    // Update stats
    droppedEventsTotal += droppedCount;
    const now = Date.now();
    for (let i = 0; i < droppedCount; i++) {
      droppedEventsHistory.push(now);
    }
    
    // Emit ONE gap event per drop episode (gap watermark)
    const gapEvent: GapEvent = {
      v: 1,
      ts: Date.now() / 1000,
      type: 'unknown',
      session_id: event.session_id || 'system',
      id: event.id ? `${event.id}:gap` : undefined,
      payload_keys: [],
      reason: 'Events dropped due to backpressure',
      gap_type: 'dropped',
      dropped_count: droppedCount,
      from_event_id: lastDeliveredEventId || 'unknown',
      to_offset: droppedEvents.length > 0 && droppedEvents[droppedEvents.length - 1].id
        ? parseInt(droppedEvents[droppedEvents.length - 1].id!.split(':')[1] || '0', 10)
        : 0,
    };
    
    // Add gap event at front of queue (will be in next batch)
    // Cast to Event since GapEvent is compatible
    queue.unshift(gapEvent as Event);
    
    console.warn(`[${new Date().toISOString()}] ⚠️ WebSocket backpressure: dropped ${droppedCount} events, emitted gap event`);
  }

  // Leading edge: if this is the first event, schedule immediate send
  if (queue.length === 1 && LEADING_EDGE && !batchTimer && !immediateScheduled) {
    immediateScheduled = true;
    setImmediate(() => {
      immediateScheduled = false;
      flushBatch();
    });
  } else if (queue.length >= MAX_BATCH_SIZE) {
    // Batch full: send now, clear any pending timers/immediates
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    immediateScheduled = false;
    flushBatch();
  } else if (!batchTimer && !immediateScheduled) {
    // Schedule batch flush
    batchTimer = setTimeout(() => {
      flushBatch();
    }, BATCH_WINDOW_MS);
  }

  return clients.size;
}

export function getWebSocketStats() {
  const now = Date.now();
  const cutoff = now - 60000;
  const recentDropped = droppedEventsHistory.filter(t => t >= cutoff).length;
  const recentSent = eventsSent; // This is total, would need separate counter for last 60s
  
  return {
    clients_open: clients.size,
    queue_size: queue.length,
    batch_window_ms: BATCH_WINDOW_MS,
    batches_sent: batchesSent,
    events_sent: eventsSent,
    dropped_events_total: droppedEventsTotal,
    dropped_events_last_60s: recentDropped,
    drop_rate_percent: recentSent > 0 ? (recentDropped / recentSent) * 100 : 0,
  };
}
