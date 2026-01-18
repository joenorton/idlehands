import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export function uninstall() {
  const hooksPath = join(process.cwd(), '.cursor', 'hooks.json');

  if (!existsSync(hooksPath)) {
    console.log('No hooks.json found. Nothing to uninstall.');
    return;
  }

  try {
    const content = readFileSync(hooksPath, 'utf-8');
    const hooks = JSON.parse(content);

    if (!hooks.hooks) {
      console.log('hooks.json does not contain a hooks property. Nothing to remove.');
      return;
    }

    // Handle both old and new format
    let removed = 0;
    
    if (hooks.version && hooks.hooks && typeof hooks.hooks === 'object' && !Array.isArray(hooks.hooks)) {
      // New format: hooks is an object with event names
      for (const eventName in hooks.hooks) {
        if (Array.isArray(hooks.hooks[eventName])) {
          const originalLength = hooks.hooks[eventName].length;
          hooks.hooks[eventName] = hooks.hooks[eventName].filter((h: any) => 
            h.owner !== 'idlehands' && (!h.command || (!h.command.includes('idlehands-hook') && !h.command.includes('runner.js')))
          );
          removed += originalLength - hooks.hooks[eventName].length;
          
          // Remove empty event arrays
          if (hooks.hooks[eventName].length === 0) {
            delete hooks.hooks[eventName];
          }
        }
      }
    } else if (Array.isArray(hooks.hooks)) {
      // Old format: hooks is an array
      const originalLength = hooks.hooks.length;
      hooks.hooks = hooks.hooks.filter((hook: any) => hook.owner !== 'idlehands');
      removed = originalLength - hooks.hooks.length;
    }

    if (removed === 0) {
      console.log('No Idlehands hooks found to remove.');
      return;
    }

    // Write updated hooks (preserving all other entries and structure)
    writeFileSync(hooksPath, JSON.stringify(hooks, null, 2), 'utf-8');
    console.log(`Removed ${removed} Idlehands hook(s) from ${hooksPath}`);
    console.log('All other hooks preserved.');
  } catch (error) {
    console.error(`Error uninstalling hooks: ${error}`);
    process.exit(1);
  }
}
