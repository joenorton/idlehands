import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Event } from '../model/events.js';

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB limit for WebSocket messages

export function setupWebSocket(server: Server) {
  wss = new WebSocketServer({ 
    server, 
    path: '/ws',
    maxPayload: MAX_MESSAGE_SIZE 
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    console.log(`[${new Date().toISOString()}] 🔌 WebSocket client connected (${clients.size} total)`);
    
    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[${new Date().toISOString()}] 🔌 WebSocket client disconnected (${clients.size} remaining)`);
    });

    ws.on('error', (error) => {
      console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error);
      clients.delete(ws);
    });
  });
}

export function broadcastEvent(event: Event): number {
  if (!wss) return 0;

  const message = JSON.stringify(event);
  let sentCount = 0;
  
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
        sentCount++;
      } catch (error) {
        // Client might have disconnected, remove it
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`[${new Date().toISOString()}] ⚠️ Failed to send message to WebSocket client: ${errorMessage}`);
        clients.delete(client);
      }
    }
  }
  
  return sentCount;
}
