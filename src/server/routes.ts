import { IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { existsSync } from 'fs';
import { readFileSync } from 'fs';
import { getEventsFilePath } from '../utils/logger.js';
import { parseEvent, type Event, type FileTouchEvent, type ToolCallEvent, type AgentStateEvent, type UnknownEvent } from '../model/events.js';
import { appendEvent } from '../utils/logger.js';
import { broadcastEvent, getWebSocketStats } from './websocket.js';
import { validateEvent } from '../model/validation.js';
import { getWatcherStats } from './fileWatcher.js';
import type { Layout } from './layout.js';

export function setupRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  layout: Layout
) {
  const parsedUrl = parse(req.url || '/', true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  if (pathname === '/api/event' && method === 'POST') {
    handlePostEvent(req, res);
    return;
  }

  if (pathname === '/api/events' && method === 'GET') {
    handleGetEvents(req, res, parsedUrl);
    return;
  }

  if (pathname === '/api/layout' && method === 'GET') {
    handleGetLayout(req, res, layout);
    return;
  }

  if (pathname === '/api/stats' && method === 'GET') {
    handleGetStats(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit for request body

async function handlePostEvent(req: IncomingMessage, res: ServerResponse) {
  let body = '';
  let bodySize = 0;
  
  req.on('data', (chunk) => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_SIZE) {
      res.writeHead(413);
      res.end('Request entity too large');
      req.destroy();
      return;
    }
    body += chunk.toString();
  });

  req.on('end', async () => {
    try {
      let event: Event;
      try {
        event = JSON.parse(body) as Event;
      } catch (parseError) {
        console.error('JSON parse error:', parseError);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', details: parseError instanceof Error ? parseError.message : 'Unknown error' }));
        return;
      }

      // Comprehensive event validation
      const validation = validateEvent(event);
      if (!validation.valid) {
        console.error('Invalid event received:', validation.errors);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: 'Invalid event', 
          details: validation.errors.map(e => `${e.field}: ${e.message}`).join('; ')
        }));
        return;
      }

      // Log for debugging
      const timestamp = new Date().toISOString();
      if (event.type === 'file_touch') {
        const ft = event as FileTouchEvent;
        console.log(`[${timestamp}] 📝 FILE_TOUCH: ${ft.path} (${ft.kind})`);
      } else if (event.type === 'tool_call') {
        const tc = event as ToolCallEvent;
        const commandInfo = tc.command ? ` command="${tc.command}"` : '';
        console.log(`[${timestamp}] 🔧 TOOL_CALL: ${tc.tool} (${tc.phase})${commandInfo}`);
      } else if (event.type === 'agent_state') {
        const as = event as AgentStateEvent;
        const metadataInfo = as.metadata ? ` ${JSON.stringify(as.metadata)}` : '';
        console.log(`[${timestamp}] 🤖 AGENT_STATE: ${as.state}${metadataInfo}`);
      } else if (event.type === 'unknown') {
        const unk = event as UnknownEvent;
        const hookName = unk.hook_event_name || 'unknown';
        const metadata = unk.metadata || {};
        const metadataStr = Object.keys(metadata).length > 0 
          ? ` ${JSON.stringify(metadata)}` 
          : '';
        console.log(`[${timestamp}] ❓ UNKNOWN (${hookName}): keys=${unk.payload_keys.join(',')} reason=${unk.reason}${metadataStr}`);
      } else {
        console.log(`[${timestamp}] 📦 ${event.type.toUpperCase()}:`, JSON.stringify(event, null, 2));
      }

      // Add temporary debug field to track ingestion path
      (event as any).ingest_path = 'api';
      
      // Append to file
      await appendEvent(event);
      console.log(`[${timestamp}] ✅ Event appended to log (ingest_path=api, event_id=${event.id || 'none'})`);
      
      // Don't broadcast directly - let file watcher pick it up and broadcast with proper ID
      // This ensures consistent event IDs and prevents duplicates
      // The file watcher will read the new line and broadcast it via WebSocket

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error('Error handling event:', errorMessage, errorStack);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Internal server error', 
        details: process.env.NODE_ENV === 'development' ? errorMessage : 'An error occurred processing the event'
      }));
    }
  });
}

function handleGetEvents(req: IncomingMessage, res: ServerResponse, parsedUrl: any) {
  const eventsFile = getEventsFilePath();

  if (!existsSync(eventsFile)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: [], next_before: null }));
    return;
  }

  try {
    // Read file as buffer to track exact byte offsets for event IDs
    // This ensures IDs match what file watcher would generate
    const fileBuffer = readFileSync(eventsFile);
    const events: Event[] = [];
    
    // Parse file buffer line by line to track exact byte offsets
    let lineStartOffset = 0;
    let i = 0;
    
    while (i < fileBuffer.length) {
      // Find next newline
      let newlineIndex = fileBuffer.indexOf(0x0A, i); // \n
      if (newlineIndex === -1) {
        // Last line (no trailing newline)
        newlineIndex = fileBuffer.length;
      }
      
      // Extract line (including newline for consistency)
      const lineBuffer = fileBuffer.slice(i, newlineIndex + (newlineIndex < fileBuffer.length ? 1 : 0));
      const lineText = lineBuffer.toString('utf-8').trim();
      
      if (lineText) {
        const event = parseEvent(lineText);
        if (event) {
          // Generate event ID using same format as file watcher: source:lineStartOffset
          // Only add ID if event doesn't already have one
          if (!event.id) {
            event.id = `file_watcher:${lineStartOffset}`;
          }
          events.push(event);
        }
      }
      
      // Move to next line (past newline)
      lineStartOffset = newlineIndex + 1;
      i = newlineIndex + 1;
      
      if (newlineIndex >= fileBuffer.length) {
        break;
      }
    }

    // Parse query parameters
    const limit = parseInt(parsedUrl.query?.limit as string || '1000', 10);
    const beforeTs = parsedUrl.query?.before_ts ? parseFloat(parsedUrl.query.before_ts as string) : null;
    const tail = parsedUrl.query?.tail ? parseInt(parsedUrl.query.tail as string, 10) : null;

    let resultEvents: Event[];
    let nextBefore: number | null = null;

    if (tail !== null) {
      // Tail window: return last N events (for initial load)
      resultEvents = events.slice(-tail);
      if (events.length > tail) {
        // Set next_before to the timestamp of the oldest event in the result
        nextBefore = resultEvents[0].ts;
      }
    } else if (beforeTs !== null) {
      // Pagination: return events before the given timestamp
      const beforeIndex = events.findIndex(e => e.ts < beforeTs);
      if (beforeIndex === -1) {
        // No events before this timestamp
        resultEvents = [];
      } else {
        // Get events before this timestamp, up to limit
        const startIndex = Math.max(0, beforeIndex - limit);
        resultEvents = events.slice(startIndex, beforeIndex).reverse(); // Reverse to get newest first
        if (startIndex > 0) {
          nextBefore = events[startIndex - 1].ts;
        }
      }
    } else {
      // Default: return last N events (tail window)
      resultEvents = events.slice(-limit);
      if (events.length > limit) {
        nextBefore = resultEvents[0].ts;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: resultEvents,
      next_before: nextBefore
    }));
  } catch (error) {
    res.writeHead(500);
    res.end('Error reading events');
  }
}

function handleGetLayout(req: IncomingMessage, res: ServerResponse, layout: Layout) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(layout));
}

async function handleGetStats(req: IncomingMessage, res: ServerResponse) {
  try {
    const wsStats = getWebSocketStats();
    const watcherStats = getWatcherStats();
    
    // Get file stats
    const eventsFile = getEventsFilePath();
    let fileStats = null;
    try {
      const { promises: fs } = await import('fs');
      const stats = await fs.stat(eventsFile);
      fileStats = {
        current_size: stats.size,
        file_sig: {
          ino: stats.ino,
          dev: stats.dev,
          size: stats.size,
          birthtimeMs: stats.birthtimeMs
        }
      };
    } catch {
      // File doesn't exist yet
    }
    
    const stats = {
      websocket: wsStats,
      watcher: watcherStats,
      file: fileStats
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
  } catch (error) {
    res.writeHead(500);
    res.end('Error getting stats');
  }
}
