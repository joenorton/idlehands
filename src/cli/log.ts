#!/usr/bin/env node

import { createEvent } from '../model/events.js';
import { appendEvent } from '../utils/logger.js';

const DEFAULT_PORT = 8765;
const SERVER_URL = `http://127.0.0.1:${DEFAULT_PORT}/api/event`;

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

async function sendEvent(event: any) {
  const serverReachable = await postToServer(event);
  if (!serverReachable) {
    await appendEvent(event);
    console.log('Event logged (server not reachable, wrote directly to file)');
  } else {
    console.log('Event sent to server');
  }
}

function generateSessionId(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5) + 'Z';
  const random = Math.random().toString(36).substring(2, 6);
  return `${timestamp}_${random}`;
}

const command = process.argv[2];

if (command === 'session-start') {
  const repoRoot = process.argv[4] || process.cwd();
  const sessionId = generateSessionId();
  const event = createEvent('session', sessionId, {
    state: 'start',
    repo_root: repoRoot,
  });
  sendEvent(event);
} else if (command === 'file-touch') {
  const pathIndex = process.argv.indexOf('--path');
  const kindIndex = process.argv.indexOf('--kind');
  
  if (pathIndex === -1 || !process.argv[pathIndex + 1]) {
    console.error('Usage: idlehands-log file-touch --path <path> [--kind read|write]');
    process.exit(1);
  }

  const path = process.argv[pathIndex + 1];
  const kind = (kindIndex !== -1 && process.argv[kindIndex + 1]) || 'write';
  const sessionId = generateSessionId();
  
  const event = createEvent('file_touch', sessionId, {
    path,
    kind: kind as 'read' | 'write',
  });
  sendEvent(event);
} else if (command === 'tool') {
  const toolIndex = process.argv.indexOf('--tool');
  const phaseIndex = process.argv.indexOf('--phase');
  
  if (toolIndex === -1 || !process.argv[toolIndex + 1]) {
    console.error('Usage: idlehands-log tool --tool <tool> [--phase start|end]');
    process.exit(1);
  }

  const tool = process.argv[toolIndex + 1];
  const phase = (phaseIndex !== -1 && process.argv[phaseIndex + 1]) || 'start';
  const sessionId = generateSessionId();
  
  const event = createEvent('tool_call', sessionId, {
    tool,
    phase: phase as 'start' | 'end',
  });
  sendEvent(event);
} else if (command === 'demo') {
  const sessionId = generateSessionId();
  const repoRoot = process.cwd();
  
  // Emit a scripted sequence
  const events = [
    createEvent('session', sessionId, { state: 'start', repo_root: repoRoot }),
    createEvent('file_touch', sessionId, { path: 'src/main.ts', kind: 'write' }),
    createEvent('tool_call', sessionId, { tool: 'terminal', phase: 'start' }),
    createEvent('tool_call', sessionId, { tool: 'terminal', phase: 'end' }),
    createEvent('file_touch', sessionId, { path: 'src/utils.ts', kind: 'write' }),
    createEvent('tool_call', sessionId, { tool: 'internet', phase: 'start' }),
    createEvent('tool_call', sessionId, { tool: 'internet', phase: 'end' }),
    createEvent('file_touch', sessionId, { path: 'package.json', kind: 'write' }),
  ];

  console.log(`Emitting ${events.length} demo events...`);
  for (const event of events) {
    await sendEvent(event);
    await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between events
  }
  console.log('Demo complete');
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Usage: idlehands-log <session-start|file-touch|tool|demo> [options]');
  process.exit(1);
}
