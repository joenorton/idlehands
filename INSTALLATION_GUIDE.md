# Adding Idlehands to a Different Repository

There are two ways to add idlehands to another repository:

## Method 1: Global Installation (Recommended)

### Step 1: Build and Install Idlehands Globally
In the **idlehands repository**:
```bash
cd /path/to/idlehands
npm install
npm run build
npm install -g .
```

This installs the `idlehands` and `idlehands-hook` commands globally.

### Step 2: Install Hooks in Your Target Repository
Navigate to your **target repository**:
```bash
cd /path/to/your/target/repo
idlehands install
```

The install command automatically detects the repository root and installs hooks to `.cursor/hooks.json`.

### Step 3: Start the Idlehands Server
In the **idlehands repository**:
```bash
npm start
```

The server runs on `http://localhost:8765` by default.

### Step 4: Restart Cursor
Restart Cursor for the hooks to take effect.

---

## Method 2: Using the Idlehands Repository Directly (Alternative)

If you don't want to install globally, you can run the install command directly:

### Step 1: Build Idlehands (if not already built)
In the **idlehands repository**:
```bash
cd /path/to/idlehands
npm install
npm run build
```

### Step 2: Install Hooks in Your Target Repository
Navigate to your **target repository** and run:
```bash
cd /path/to/your/target/repo
node /path/to/idlehands/dist/cli/index.js install
```

**Note:** After running this, you may need to manually edit `.cursor/hooks.json` in your target repo to ensure the hook runner path points to the correct idlehands installation. The hook runner path should be:
- Windows: `node "E:\\dev\\idlehands\\dist\\hook\\runner.js"`
- Linux/Mac: `/path/to/idlehands/dist/hook/runner.js`

### Step 3: Start the Server
In the **idlehands repository**:
```bash
npm start
```

### Step 4: Restart Cursor
Restart Cursor for the hooks to take effect.

---

## Quick Reference Commands

### From Idlehands Repository:
- `npm run build` - Build the project
- `npm start` - Start the server
- `npm run install-hooks` - Install hooks (uses current directory as repo root)
- `node dist/cli/index.js install` - Install hooks explicitly
- `node dist/cli/index.js uninstall` - Remove hooks
- `node dist/cli/index.js doctor` - Check system health

### After Global Installation:
- `idlehands install` - Install hooks in current repo
- `idlehands uninstall` - Remove hooks from current repo
- `idlehands doctor` - Check system health
- **Note:** To start the server, run `npm start` from the idlehands repository directory (global install doesn't include a start command)

---

## How It Works

1. **Hook Installation**: The `install` command creates/updates `.cursor/hooks.json` in your repository root with hooks for these Cursor events:
   - `afterFileEdit` - File modifications
   - `beforeReadFile` - File reads
   - `beforeShellExecution` - Terminal commands (before)
   - `afterShellExecution` - Terminal commands (after)
   - `beforeMCPExecution` - MCP tool calls (before)
   - `afterMCPExecution` - MCP tool calls (after)
   - `afterAgentResponse` - Agent responses
   - `afterAgentThought` - Agent thoughts
   - `stop` - Session end

2. **Hook Runner**: The hooks point to the hook runner (`dist/hook/runner.js`), which:
   - Extracts events from Cursor's hook payloads
   - Sends events to the idlehands server via HTTP POST
   - Logs events to `~/.idlehands/events.ndjson`

3. **Server**: The idlehands server:
   - Receives events from hook runners
   - Serves the web UI at `http://localhost:8765`
   - Streams events to connected clients via WebSocket

---

## Troubleshooting

### Hooks Not Working?
1. Verify hooks are installed: Check `.cursor/hooks.json` exists in your repo root
2. Restart Cursor after installing hooks
3. Check debug log: `~/.idlehands/hook-debug.log` (set `IDLEHANDS_DEBUG=1` first)
4. Run `idlehands doctor` or `node dist/cli/index.js doctor` to check system health

### Server Not Running?
- Make sure you run `npm start` in the idlehands repository
- Check that port 8765 is available
- Verify the server is accessible at `http://localhost:8765`

### Events Not Appearing?
- Ensure the server is running
- Check browser console for WebSocket connection
- Verify events are being logged to `~/.idlehands/events.ndjson`
- Run `idlehands doctor` to diagnose issues

---

## Notes

- The install command automatically finds the repository root by looking for a `.git` directory
- Existing hooks in `.cursor/hooks.json` are preserved (idlehands hooks are added, not replaced)
- A backup of your original `hooks.json` is created as `hooks.json.bak` on first install
- The hook runner path in `hooks.json` uses absolute paths, so it works regardless of where Cursor is launched from
