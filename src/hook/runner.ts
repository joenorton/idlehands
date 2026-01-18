#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join } from 'path';
import { extractEventFromPayload } from '../model/payload.js';
import { appendEvent } from '../utils/logger.js';
import { createEvent } from '../model/events.js';

const DEFAULT_PORT = 8765;
const SERVER_URL = `http://127.0.0.1:${DEFAULT_PORT}/api/event`;

// Simple session ID storage (per process)
let sessionId: string | null = null;

function generateSessionId(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5) + 'Z';
  const random = Math.random().toString(36).substring(2, 6);
  return `${timestamp}_${random}`;
}

function getSessionId(): string {
  if (!sessionId) {
    sessionId = generateSessionId();
  }
  return sessionId;
}

async function postToServer(event: any): Promise<boolean> {
  try {
    const response = await fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  // ALWAYS log to debug file for now (until we confirm hooks work)
  const { appendFileSync } = await import('fs');
  const { ensureIdlehandsDir } = await import('../utils/logger.js');
  await ensureIdlehandsDir();
  const debugLog = join(process.env.HOME || process.env.USERPROFILE || '', '.idlehands', 'hook-debug.log');
  
  try {
    appendFileSync(debugLog, `[${new Date().toISOString()}] Hook runner started\n`);
    
    // Read JSON from stdin
    const stdin = readFileSync(0, 'utf-8').trim();
    appendFileSync(debugLog, `[${new Date().toISOString()}] Stdin length: ${stdin.length}\n`);
    
    if (!stdin) {
      appendFileSync(debugLog, `[${new Date().toISOString()}] No stdin, exiting\n`);
      process.exit(0);
    }

    let payload: any;
    try {
      payload = JSON.parse(stdin);
      appendFileSync(debugLog, `[${new Date().toISOString()}] Parsed payload: ${JSON.stringify(payload, null, 2)}\n`);
    } catch (error) {
      appendFileSync(debugLog, `[${new Date().toISOString()}] JSON parse error: ${error}\n`);
      appendFileSync(debugLog, `[${new Date().toISOString()}] Raw stdin: ${stdin.substring(0, 500)}\n`);
      process.exit(0);
    }

    const sessionId = getSessionId();
    
    // Try to extract repo_root from payload or environment
    const repoRoot = payload.repo_root || payload.repoRoot || process.env.CURSOR_REPO_ROOT || process.cwd();
    
    // Extract event using compatibility shim
    const event = extractEventFromPayload(payload, sessionId, repoRoot);

    appendFileSync(debugLog, `[${new Date().toISOString()}] Created event: ${JSON.stringify(event, null, 2)}\n`);

    // Try to POST to server first
    const serverReachable = await postToServer(event);
    appendFileSync(debugLog, `[${new Date().toISOString()}] Server reachable: ${serverReachable}\n`);
    
    if (!serverReachable) {
      // Fallback: append directly to file
      await appendEvent(event);
      appendFileSync(debugLog, `[${new Date().toISOString()}] Appended to file (server unreachable)\n`);
    }

    appendFileSync(debugLog, `[${new Date().toISOString()}] Hook completed successfully\n`);
    process.exit(0);
  } catch (error) {
    // Always log errors
    appendFileSync(debugLog, `[${new Date().toISOString()}] ERROR: ${error}\n`);
    if (error instanceof Error) {
      appendFileSync(debugLog, `[${new Date().toISOString()}] Stack: ${error.stack}\n`);
    }
    process.exit(0);
  }
}

main();
