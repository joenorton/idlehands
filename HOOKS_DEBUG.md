# Debugging Cursor Hooks

To make Cursor activity trigger the visualization, you need:

1. **Server running**: `npm start`
2. **Hooks installed**: `npm run install-hooks`
3. **Cursor actually calling the hooks**

## Check if hooks are being called

Enable debug logging:

```bash
# Windows PowerShell
$env:IDLEHANDS_DEBUG="1"
npm start

# Then in another terminal, check the debug log:
type $env:USERPROFILE\.idlehands\hook-debug.log
```

Or on Linux/Mac:
```bash
export IDLEHANDS_DEBUG=1
npm start

# Check debug log:
cat ~/.idlehands/hook-debug.log
```

## Verify hook runner path

The hooks.json should point to the compiled hook runner. Check:

```bash
# See what's in hooks.json
cat .cursor/hooks.json
```

The `command` should be the full path to `dist/hook/runner.js` or `idlehands-hook` if installed globally.

## Cursor Hook API

We're using these hook trigger names (verified with Cursor):
- `afterFileEdit` - for file modifications
- `beforeReadFile` - for file reads
- `beforeShellExecution` - for terminal/command execution (before)
- `afterShellExecution` - for terminal/command execution (after)
- `afterAgentResponse` - for agent responses
- `afterAgentThought` - for agent thoughts
- `stop` - for session end

The hook runner extracts events from these payloads and normalizes them into our event format.

## Test manually

You can test if the hook runner works by calling it directly:

```bash
# Test file touch event
echo '{"file_path":"src/test.ts","hook_event_name":"afterFileEdit"}' | node dist/hook/runner.js

# Test tool call event (without command)
echo '{"hook_event_name":"afterShellExecution"}' | node dist/hook/runner.js

# Test tool call event with command (terminal commands will show in UI)
echo '{"hook_event_name":"afterShellExecution","command":"npm run build"}' | node dist/hook/runner.js
```

Then check if an event appears in the UI or log file (`~/.idlehands/events.ndjson`).

## Event Extraction

The hook runner extracts the following from payloads:

- **File paths**: From `file_path`, `path`, `uri`, `edits[]`, `attachments[]`, or `files[]` fields
- **Command strings**: From `command`, `command_line`, `cmd`, or `shell.command` fields
- **Tool names**: From `tool`, `toolName`, `tool_name`, or inferred from hook event names
- **Read/write kind**: Determined from hook event name (`beforeReadFile` = read, `afterFileEdit` = write)

Terminal commands are displayed in the activity log under the EXECUTING mode when available.

## Agent State Events

Agent state events are created from `afterAgentThought` and `afterAgentResponse` hooks:

- **afterAgentThought** → `agent_state` event with `state: "thinking"` (displays 💡 lightbulb emoji)
- **afterAgentResponse** → `agent_state` event with `state: "responding"` (displays 💬 speech balloon emoji)

These are **trailing-edge events** (they occur after the agent has finished thinking/responding). They:
- Display ephemeral emoji bubbles (💡 for thinking, 💬 for responding) that automatically fade out after ~4 seconds
- Appear in the activity log as **THOUGHT_COMPLETE** and **RESPONSE_COMPLETE** (not THINKING/RESPONDING)
- Do **not** move the agent or create activity zones (they are not duration-based states)
- Do **not** cause state transitions in the state machine
- The agent stays in its current position (activity zone) while displaying the emoji bubble

## Unknown Events

Some events may be logged as "unknown" if they don't contain observable file/tool activity:

- **afterAgentThought**: Agent thinking events without observable file or tool activity are logged as unknown with metadata (model, duration_ms, generation_id). These don't trigger state transitions.
- **afterAgentResponse**: Agent response events without observable activity are logged as unknown with metadata including a text preview.

Unknown events include metadata in the server logs to help identify them:
```
❓ UNKNOWN (afterAgentThought): keys=... reason=... {"duration_ms":1234,"model":"gpt-4","generation_id":"gen_123"}
```

These events are informational and don't affect the visualization state.

## Tool Call Lifecycle

Tool calls are tracked with start/end pairs:
- **tool_call phase="start"**: Agent transitions to EXECUTING zone, tool call is tracked
- **tool_call phase="end"**: Agent returns to previous activity zone, tool call is cleared
- **Missing end event**: If no end event is received within 30 seconds, the tool call is marked as incomplete/hung but does not keep the UI stuck

## Session Boundaries

Session events mark session boundaries:
- **session state="start"**: Session begins
- **session state="stop"**: Session ends - agent returns to home position, all active tool calls are cleared

## WebSocket Disconnect Handling

When the WebSocket disconnects:
- UI shows "Disconnected" overlay and freezes (doesn't render map/agent)
- All active tool calls are cleared
- Auto-reconnects after 3 seconds

## Common issues

1. **Hooks not being called**: Cursor might not support hooks, or the trigger names are wrong
2. **Server not reachable**: Make sure `npm start` is running
3. **Path issues**: The hook runner path in hooks.json might be wrong
