import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getEventsFilePath } from '../utils/logger.js';
import { createEvent } from '../model/events.js';

const DEFAULT_PORT = 8765;
const SERVER_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

async function checkServer(): Promise<boolean> {
  try {
    const response = await fetch(`${SERVER_URL}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
    });
    return response.ok || response.status === 400; // 400 is ok, means server is reachable
  } catch {
    return false;
  }
}

function checkHooksJson(): { exists: boolean; hasIdlehands: boolean } {
  const hooksPath = join(process.cwd(), '.cursor', 'hooks.json');
  const exists = existsSync(hooksPath);
  
  if (!exists) {
    return { exists: false, hasIdlehands: false };
  }

  try {
    const content = readFileSync(hooksPath, 'utf-8');
    const hooks = JSON.parse(content);
    
    if (!Array.isArray(hooks.hooks)) {
      return { exists: true, hasIdlehands: false };
    }

    // Check both old and new format
    let hasIdlehands = false;
    if (hooks.version && hooks.hooks && typeof hooks.hooks === 'object') {
      // New format
      for (const eventName in hooks.hooks) {
        if (Array.isArray(hooks.hooks[eventName])) {
          hasIdlehands = hooks.hooks[eventName].some((h: any) => 
            h.owner === 'idlehands' || (h.command && h.command.includes('idlehands-hook'))
          );
          if (hasIdlehands) break;
        }
      }
    } else if (Array.isArray(hooks.hooks)) {
      // Old format
      hasIdlehands = hooks.hooks.some((hook: any) => hook.owner === 'idlehands');
    }
    return { exists: true, hasIdlehands };
  } catch {
    return { exists: true, hasIdlehands: false };
  }
}

async function testEventFlow(): Promise<boolean> {
  try {
    const testEvent = createEvent('unknown', 'doctor-test', {
      payload_keys: ['test'],
      reason: 'Doctor test event',
    });

    const response = await fetch(`${SERVER_URL}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testEvent),
    });

    if (!response.ok) {
      return false;
    }

    // Wait a bit and check if event appears
    await new Promise(resolve => setTimeout(resolve, 500));

    const eventsResponse = await fetch(`${SERVER_URL}/api/events?tail=10`);
    if (!eventsResponse.ok) {
      return false;
    }

    const events = await eventsResponse.json() as any[];
    return events.some((e: any) => e.session_id === 'doctor-test');
  } catch {
    return false;
  }
}

export async function doctor() {
  console.log('Idlehands Doctor\n');

  // Check log file location
  const logPath = getEventsFilePath();
  const logExists = existsSync(logPath);
  console.log(`Log file: ${logPath}`);
  console.log(`  Status: ${logExists ? '✓ Exists' : '✗ Not found'}\n`);

  // Check server
  console.log(`Server: ${SERVER_URL}`);
  const serverReachable = await checkServer();
  console.log(`  Status: ${serverReachable ? '✓ Reachable' : '✗ Not reachable'}\n`);

  // Check hooks.json
  const hooks = checkHooksJson();
  console.log(`Hooks file: .cursor/hooks.json`);
  console.log(`  Exists: ${hooks.exists ? '✓' : '✗'}`);
  if (hooks.exists) {
    console.log(`  Has Idlehands hooks: ${hooks.hasIdlehands ? '✓' : '✗'}`);
  }
  console.log();

  // Test event flow
  if (serverReachable) {
    console.log('Testing event flow...');
    const flowWorks = await testEventFlow();
    console.log(`  Status: ${flowWorks ? '✓ Events flowing' : '✗ Event flow broken'}\n`);
  } else {
    console.log('Skipping event flow test (server not reachable)\n');
  }

  // Summary
  // Log file not existing is OK - it will be created on first event
  const allGood = serverReachable && hooks.exists && hooks.hasIdlehands;
  if (allGood) {
    console.log('✓ All checks passed!');
    if (!logExists) {
      console.log('  (Log file will be created when first event is received)');
    }
  } else {
    console.log('⚠ Some issues detected.');
    if (!hooks.exists || !hooks.hasIdlehands) {
      console.log('  Run `npm run build && node dist/cli/index.js install` to install hooks.');
    }
    if (!serverReachable) {
      console.log('  Start the server with `npm start`');
    }
  }
}
