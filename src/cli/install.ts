import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findRepoRoot(): string | null {
  let current = process.cwd();
  const root = current.split(/[/\\]/)[0] + (process.platform === 'win32' ? '\\' : '/');
  
  while (current !== root) {
    const gitDir = join(current, '.git');
    if (existsSync(gitDir)) {
      return current;
    }
    current = join(current, '..');
  }
  return process.cwd(); // Fallback to current directory
}

function getIdlehandsHookPath(): string {
  // Get the absolute path to the hook runner
  // On Windows, we need to use 'node' explicitly to execute the file
  const distPath = join(process.cwd(), 'dist', 'hook', 'runner.js');
  if (existsSync(distPath)) {
    // Use node to execute the file explicitly
    if (process.platform === 'win32') {
      return `node "${distPath}"`;
    } else {
      return distPath;
    }
  }
  // Fallback to idlehands-hook command (if installed globally)
  return 'idlehands-hook';
}

export function install() {
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    console.error('Could not determine repository root');
    process.exit(1);
  }

  const hooksPath = join(repoRoot, '.cursor', 'hooks.json');
  const backupPath = join(repoRoot, '.cursor', 'hooks.json.bak');
  const hookRunnerPath = getIdlehandsHookPath();

  let existingHooks: any = null;
  
  // Read existing hooks if present
  if (existsSync(hooksPath)) {
    try {
      const content = readFileSync(hooksPath, 'utf-8');
      existingHooks = JSON.parse(content);
      
      // Create backup on first install
      if (!existsSync(backupPath)) {
        copyFileSync(hooksPath, backupPath);
        console.log(`Created backup: ${backupPath}`);
      }
    } catch (error) {
      console.error(`Error reading existing hooks.json: ${error}`);
      process.exit(1);
    }
  }

  // Initialize hooks structure if needed
  if (!existingHooks) {
    existingHooks = { version: 1, hooks: {} };
  }

  // Cursor uses format: { version: 1, hooks: { eventName: [{ command: ... }] } }
  // Ensure version and hooks object exist
  if (!existingHooks.version) {
    existingHooks.version = 1;
  }
  
  if (!existingHooks.hooks || typeof existingHooks.hooks !== 'object' || Array.isArray(existingHooks.hooks)) {
    // Convert old array format to new object format if needed
    const oldHooks = Array.isArray(existingHooks.hooks) ? existingHooks.hooks : [];
    existingHooks.hooks = {};
    
    // Preserve old hooks if they exist
    for (const hook of oldHooks) {
      if (hook.trigger) {
        if (!existingHooks.hooks[hook.trigger]) {
          existingHooks.hooks[hook.trigger] = [];
        }
        existingHooks.hooks[hook.trigger].push({
          command: hook.command,
          owner: hook.owner,
        });
      }
    }
  }

  // Check if idlehands hooks already exist
  let hasIdlehands = false;
  for (const eventName in existingHooks.hooks) {
    if (Array.isArray(existingHooks.hooks[eventName])) {
      hasIdlehands = existingHooks.hooks[eventName].some((h: any) => 
        h.owner === 'idlehands' || (h.command && h.command.includes('idlehands-hook'))
      );
      if (hasIdlehands) break;
    }
  }

  // Remove old gibson hooks if they exist (migration from old project name)
  let removedGibson = 0;
  for (const eventName in existingHooks.hooks) {
    if (Array.isArray(existingHooks.hooks[eventName])) {
      const originalLength = existingHooks.hooks[eventName].length;
      existingHooks.hooks[eventName] = existingHooks.hooks[eventName].filter((h: any) => {
        // Keep hook if it's not a gibson hook
        const isGibson = h.owner === 'gibson' || (h.command && h.command.includes('gibson-hook'));
        return !isGibson;
      });
      removedGibson += originalLength - existingHooks.hooks[eventName].length;
      
      // Remove empty event arrays
      if (existingHooks.hooks[eventName].length === 0) {
        delete existingHooks.hooks[eventName];
      }
    }
  }
  
  if (removedGibson > 0) {
    console.log(`Removed ${removedGibson} old Gibson hook(s) (migrating to Idlehands)`);
  }

  if (hasIdlehands) {
    console.log('Idlehands hooks already installed');
    if (removedGibson === 0) {
      return;
    }
    // If we removed gibson hooks, continue to ensure hooks are properly set up
  }

  // Add idlehands hooks to valid Cursor events
  // Valid types: beforeShellExecution, beforeMCPExecution, afterShellExecution, afterMCPExecution,
  // beforeReadFile, afterFileEdit, beforeTabFileRead, afterTabFileEdit, stop,
  // beforeSubmitPrompt, afterAgentResponse, afterAgentThought
  const events = [
    'afterFileEdit',        // File modifications
    'beforeReadFile',       // File reads
    'beforeShellExecution', // Terminal commands (before)
    'afterShellExecution',  // Terminal commands (after)
    'afterAgentResponse',  // Agent responses
    'afterAgentThought',   // Agent thoughts
    'stop',                // Session end
  ];
  for (const event of events) {
    if (!existingHooks.hooks[event]) {
      existingHooks.hooks[event] = [];
    }
    existingHooks.hooks[event].push({
      command: hookRunnerPath,
      owner: 'idlehands',
    });
  }

  // Write updated hooks - ensure version is first
  try {
    const output = {
      version: existingHooks.version || 1,
      hooks: existingHooks.hooks,
    };
    writeFileSync(hooksPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`Installed Idlehands hooks to ${hooksPath}`);
    console.log(`Added hooks for events: ${events.join(', ')}`);
    console.log('\nIMPORTANT: You may need to restart Cursor for hooks to take effect.');
    console.log('Check ~/.idlehands/hook-debug.log to see if hooks are being called.');
  } catch (error) {
    console.error(`Error writing hooks.json: ${error}`);
    process.exit(1);
  }
}
