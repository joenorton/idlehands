import { IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { readFileSync, existsSync } from 'fs';
import { getEventsFilePath } from '../utils/logger.js';
import { parseEvent, type Event, type FileTouchEvent, type ToolCallEvent, type AgentStateEvent, type UnknownEvent } from '../model/events.js';
import { appendEvent } from '../utils/logger.js';
import { broadcastEvent } from './websocket.js';
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
      const event = JSON.parse(body) as Event;
      
      // Validate event structure
      if (!event.v || !event.ts || !event.type || !event.session_id) {
        console.error('Invalid event received:', event);
        res.writeHead(400);
        res.end('Invalid event');
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

      // Append to file
      await appendEvent(event);
      console.log(`[${timestamp}] ✅ Event appended to log`);
      
      // Broadcast via WebSocket
      const clientsCount = broadcastEvent(event);
      console.log(`[${timestamp}] 📡 Broadcast to ${clientsCount} WebSocket client(s)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      console.error('Error handling event:', error);
      res.writeHead(400);
      res.end('Invalid JSON');
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
    const content = readFileSync(eventsFile, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    const events: Event[] = [];

    for (const line of lines) {
      const event = parseEvent(line);
      if (event) {
        events.push(event);
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
