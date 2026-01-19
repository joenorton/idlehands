# Event System Reference

This document provides a comprehensive reference for the Idlehands event system, covering event structure, flow, deduplication, and all components involved in event processing.

## Table of Contents

1. [Event Structure](#event-structure)
2. [Event Types](#event-types)
3. [Event Flow](#event-flow)
4. [Event IDs and Deduplication](#event-ids-and-deduplication)
5. [File Watcher](#file-watcher)
6. [WebSocket Broadcasting](#websocket-broadcasting)
7. [Client-Side Processing](#client-side-processing)
8. [Validation](#validation)
9. [Best Practices](#best-practices)

## Event Structure

All events follow a common base structure:

```typescript
interface BaseEvent {
  v: number;              // Version (currently 1)
  ts: number;             // Unix timestamp in seconds (float)
  type: EventType;        // Event type (see below)
  session_id: string;     // Session identifier
  id?: string;            // Canonical event ID (assigned by system)
}
```

### Event Format

Events are stored as JSON lines (one event per line) in the events log file. Each line is a complete, valid JSON object.

**Example:**
```json
{"v":1,"ts":1704067200.123,"type":"file_touch","session_id":"session_abc","path":"src/app.ts","kind":"read"}
```

## Event Types

### 1. Session Event

Tracks session lifecycle.

```typescript
interface SessionEvent extends BaseEvent {
  type: 'session';
  state: 'start' | 'stop' | 'interrupt' | 'crash';
  repo_root?: string;  // Optional repository root path
}
```

**Example:**
```json
{"v":1,"ts":1704067200.0,"type":"session","session_id":"session_abc","state":"start","repo_root":"/path/to/repo"}
```

### 2. File Touch Event

Records file read/write operations.

```typescript
interface FileTouchEvent extends BaseEvent {
  type: 'file_touch';
  path: string;          // Absolute or relative file path
  kind: 'read' | 'write';
}
```

**Example:**
```json
{"v":1,"ts":1704067200.5,"type":"file_touch","session_id":"session_abc","path":"src/app.ts","kind":"read"}
```

### 3. Tool Call Event

Tracks tool/command execution lifecycle.

```typescript
interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  tool: string;          // Tool name (e.g., "terminal", "mcp", "internet")
  phase: 'start' | 'end';
  command?: string;       // Optional command string
}
```

**Example:**
```json
{"v":1,"ts":1704067201.0,"type":"tool_call","session_id":"session_abc","tool":"terminal","phase":"start","command":"npm install"}
```

### 4. Agent State Event

Represents agent internal states (ephemeral beacons).

```typescript
interface AgentStateEvent extends BaseEvent {
  type: 'agent_state';
  state: 'thinking' | 'responding';
  metadata?: Record<string, any>;  // Optional metadata (model, duration, etc.)
}
```

**Example:**
```json
{"v":1,"ts":1704067202.0,"type":"agent_state","session_id":"session_abc","state":"thinking","metadata":{"model":"gpt-4"}}
```

### 5. Unknown Event

Fallback for unrecognized or malformed events.

```typescript
interface UnknownEvent extends BaseEvent {
  type: 'unknown';
  payload_keys: string[];      // Keys found in original payload
  reason?: string;              // Why event is unknown
  hook_event_name?: string;      // Original hook event name
  metadata?: Record<string, any>;
}
```

**Example:**
```json
{"v":1,"ts":1704067203.0,"type":"unknown","session_id":"session_abc","payload_keys":["action","target"],"reason":"Unrecognized event type"}
```

## Event Flow

The event system follows this flow:

```
┌─────────────┐
│   Hook      │  Emits events via HTTP POST
│   Runner    │  ────────────────────────┐
└─────────────┘                          │
                                         ▼
┌─────────────┐                    ┌─────────────┐
│   API       │  Validates &       │   Events    │
│   Route     │  Appends to file   │   Log File  │
│  (/api/event)│  ─────────────────▶│  (JSONL)    │
└─────────────┘                    └─────────────┘
                                         │
                                         │ File change
                                         ▼
┌─────────────┐                    ┌─────────────┐
│   File      │  Reads new lines    │  WebSocket  │
│   Watcher   │  & assigns IDs     │  Broadcast  │
│             │  ─────────────────▶│             │
└─────────────┘                    └─────────────┘
                                         │
                                         │ Batched messages
                                         ▼
┌─────────────┐                    ┌─────────────┐
│   Client    │  Receives events    │  Activity  │
│   (Browser) │  & processes       │  Log UI    │
│             │  ─────────────────▶│             │
└─────────────┘                    └─────────────┘
```

### 1. Event Ingestion

Events are ingested via HTTP POST to `/api/event`:

```bash
POST /api/event
Content-Type: application/json

{
  "v": 1,
  "ts": 1704067200.0,
  "type": "file_touch",
  "session_id": "session_abc",
  "path": "src/app.ts",
  "kind": "read"
}
```

**Process:**
1. Request body is validated (size limit: 1MB)
2. JSON is parsed
3. Event is validated using `validateEvent()`
4. Event is appended to events log file (one line per event)
5. Response: `{"ok": true}`

**Note:** Events are NOT broadcast directly from the API route. They are picked up by the file watcher to ensure consistent event IDs.

### 2. Event Storage

Events are stored in a JSONL (JSON Lines) file:
- Location: `~/.idlehands/events.jsonl` (or configured path)
- Format: One JSON object per line, terminated by `\n`
- Append-only: Events are never modified, only appended

### 3. File Watcher Processing

The file watcher:
1. Monitors the events log file for changes
2. Reads new bytes from the last known position
3. Splits into complete lines (handles partial lines via carry buffer)
4. Generates canonical event IDs: `file_watcher:{lineStartOffset}`
5. Checks for duplicates before parsing
6. Parses and validates events
7. Broadcasts events via WebSocket

**Key Features:**
- Single-flight queue: Only one read operation at a time
- Offset tracking: Tracks exact byte offsets for event IDs
- Duplicate detection: Prevents same event from being processed twice
- File rotation handling: Detects truncation and resets state

### 4. WebSocket Broadcasting

Events are broadcast to connected clients via WebSocket:

**Connection:**
```
ws://localhost:8765/ws
```

**Message Format:**
```json
{
  "type": "batch",
  "events": [
    {"v":1,"ts":1704067200.0,"type":"file_touch",...},
    {"v":1,"ts":1704067201.0,"type":"tool_call",...}
  ]
}
```

**Batching:**
- Batch window: 50ms
- Max batch size: 100 events
- Leading edge: First event triggers immediate send
- Backpressure: Drops oldest events if queue exceeds 1000 events

### 5. Client-Side Processing

The client:
1. Receives batched events via WebSocket
2. Processes events through state machine
3. Updates activity log (with deduplication)
4. Updates timeline visualization
5. Triggers agent animations and zone pulses

## Event IDs and Deduplication

### Event ID Format

Event IDs follow the pattern: `{source}:{offset}`

- **Source:** `file_watcher` (for events read from file)
- **Offset:** Byte offset of the line start in the events log file

**Example:** `file_watcher:12345`

### Deduplication Layers

The system has three layers of duplicate detection:

#### 1. File Watcher Layer

- **Location:** `src/server/fileWatcher.ts`
- **Mechanism:** Tracks seen event IDs in a `Set<string>`
- **Check:** Before parsing (saves CPU)
- **Action:** Skips duplicate lines entirely

```typescript
const eventId = `file_watcher:${startOffset}`;
if (seenEventIds.has(eventId)) {
  console.error(`[FileWatcher] ⚠️ DUPLICATE DETECTED - SKIPPING`);
  continue; // Skip this line
}
seenEventIds.add(eventId); // Mark as seen immediately
```

#### 2. WebSocket Layer

- **Location:** `src/server/websocket.ts`
- **Mechanism:** Tracks recent event IDs with timestamps (5-second window)
- **Check:** Before queuing events
- **Action:** Prevents duplicate from being queued

```typescript
if (recentEventIds.has(event.id)) {
  const age = now - recentEventIds.get(event.id).timestamp;
  if (age < 5000) { // 5 second window
    console.error(`[WebSocket] ⚠️ DUPLICATE DETECTED - DROPPING`);
    return; // Don't queue
  }
}
recentEventIds.set(event.id, { timestamp: now });
```

#### 3. Activity Log Layer

- **Location:** `src/ui/activityLog.ts`
- **Mechanism:** Tracks seen event keys in a `Set<string>`
- **Check:** Before adding to log entries
- **Action:** Skips duplicate events

```typescript
const eventKey = event.id || this.getEventKey(event);
if (this.seenEvents.has(eventKey)) {
  return; // Already seen, skip
}
this.seenEvents.add(eventKey);
```

### Why Multiple Layers?

1. **File Watcher:** Prevents duplicate parsing if file is read twice
2. **WebSocket:** Prevents duplicate transmission if same event is broadcast twice
3. **Activity Log:** Final safeguard if same event reaches client twice

## File Watcher

### Initialization

The file watcher:
1. Checks if events log file exists
2. If exists: Initializes `lastOffset` to end of file (only new events)
3. If not: Waits and retries every 1 second
4. Sets up `fs.watch()` on the events log file

### Reading Process

1. **Trigger:** File change event from `fs.watch()`
2. **Single-flight:** If already reading, mark `dirty` flag and return
3. **Read:** Read bytes from `lastOffset` to EOF
4. **Split:** Combine with carry buffer, split into complete lines
5. **Process:** For each line:
   - Generate event ID
   - Check for duplicates
   - Parse JSON
   - Validate event
   - Add to events array
6. **Broadcast:** Send all events via WebSocket
7. **Update:** Update `lastOffset` to position after last complete line

### Error Handling

- **Transient errors:** Reset `lastOffset` to 0, retry
- **Consecutive errors:** After 10 errors, reset watcher and reinitialize
- **File truncation:** Clear state, emit reset event, start from beginning

### State Management

```typescript
let lastOffset = 0;              // Byte offset of last emitted event
let carry = Buffer.alloc(0);      // Partial line remainder
let lastEmittedOffset = 0;        // For monotonicity checks
let seenEventIds = new Set();    // Duplicate detection
let reading = false;             // Single-flight flag
let dirty = false;               // Re-read flag
```

## WebSocket Broadcasting

### Connection Management

- **Path:** `/ws`
- **Max payload:** 1MB per message
- **Client tracking:** Each client gets unique ID for debugging

### Batching Strategy

**Configuration:**
- Batch window: 50ms
- Max batch size: 100 events
- Max queue size: 1000 events (backpressure threshold)
- Leading edge: Enabled (first event triggers immediate send)

**Batching Logic:**
1. Events are added to queue
2. If queue is empty and leading edge enabled: Schedule immediate flush
3. If queue reaches max batch size: Flush immediately
4. Otherwise: Schedule flush after batch window expires

### Backpressure Handling

When queue exceeds 1000 events:
1. Drop oldest events (coherent dropping)
2. Emit gap event to notify clients of dropped events
3. Update statistics

**Gap Event:**
```json
{
  "v": 1,
  "ts": 1704067200.0,
  "type": "unknown",
  "gap_type": "dropped",
  "dropped_count": 50,
  "from_event_id": "file_watcher:1000",
  "to_offset": 2000,
  "reason": "Events dropped due to backpressure"
}
```

### Statistics

The WebSocket layer tracks:
- `clients_open`: Number of connected clients
- `queue_size`: Current queue size
- `batches_sent`: Total batches sent
- `events_sent`: Total events sent
- `dropped_events_total`: Total events dropped
- `dropped_events_last_60s`: Events dropped in last 60 seconds

## Client-Side Processing

### Event Reception

Events are received as batched messages:

```typescript
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'batch') {
    for (const newEvent of message.events) {
      // Process each event
    }
  }
};
```

### Processing Pipeline

1. **State Machine:** Processes activity events (file_touch, tool_call) for zone transitions
2. **Activity Log:** Adds events to activity log (with deduplication)
3. **Timeline:** Updates timeline visualization
4. **Agent Controller:** Updates agent position and animations
5. **Map Renderer:** Triggers zone pulses and updates visualizations

### Activity Log Deduplication

The activity log uses event IDs for deduplication:

```typescript
const eventKey = event.id || this.getEventKey(event);
if (this.seenEvents.has(eventKey)) {
  return; // Skip duplicate
}
this.seenEvents.add(eventKey);
```

**Event Key Generation:**
- If event has `id`: Use it directly
- Otherwise: Generate key from `{ts}:{type}:{identifying_fields}`

### Memory Management

- **Max events in memory:** 50,000 events
- **Max activity log entries:** 10,000 entries
- **Cleanup:** Oldest events removed when limits exceeded
- **Virtual scrolling:** Only visible entries are rendered

## Validation

### Validation Rules

Events are validated using `validateEvent()`:

**Base Fields:**
- `v`: Must be exactly `1`
- `ts`: Must be a number, non-negative, not more than 60s in future
- `type`: Must be one of: `session`, `file_touch`, `tool_call`, `unknown`, `agent_state`
- `session_id`: Required string, 1-256 characters

**Type-Specific:**
- `file_touch`: `path` required (max 4096 chars), `kind` must be `read` or `write`
- `tool_call`: `tool` required (max 256 chars), `phase` must be `start` or `end`, `command` optional (max 8192 chars)
- `session`: `state` required, must be `start`, `stop`, `interrupt`, or `crash`
- `agent_state`: `state` must be `thinking` or `responding`
- `unknown`: `payload_keys` must be array (max 100 items), `reason` optional (max 512 chars)

**Metadata:**
- Must be JSON-serializable object
- Max size: 10,000 bytes when serialized

### Validation Errors

Invalid events return:
```json
{
  "error": "Invalid event",
  "details": "field: message; field2: message2"
}
```

## Best Practices

### Event Creation

1. **Always set `v: 1`** - Required for all events
2. **Use accurate timestamps** - `ts` should be current time in seconds (float)
3. **Include session_id** - All events must have a session identifier
4. **Use appropriate event types** - Don't use `unknown` unless necessary
5. **Keep paths relative** - File paths should be relative to repo root when possible

### Performance

1. **Batch operations** - Multiple file touches can be batched if they occur together
2. **Avoid high-frequency events** - Don't emit events more than 100/second
3. **Keep metadata small** - Large metadata objects slow down processing
4. **Use tool_call phases** - Always emit both `start` and `end` phases

### Debugging

1. **Check event IDs** - Duplicate events will have same ID
2. **Monitor WebSocket queue** - High queue size indicates backpressure
3. **Watch file watcher logs** - Look for duplicate detection messages
4. **Check activity log** - Verify events appear correctly in UI

### Error Handling

1. **Validate before sending** - Use `validateEvent()` before POSTing
2. **Handle validation errors** - Check API response for validation failures
3. **Retry on transient errors** - Network errors can be retried
4. **Don't duplicate events** - If unsure if event was sent, check logs first

## API Reference

### POST /api/event

Submit a new event.

**Request:**
```json
{
  "v": 1,
  "ts": 1704067200.0,
  "type": "file_touch",
  "session_id": "session_abc",
  "path": "src/app.ts",
  "kind": "read"
}
```

**Response:**
```json
{
  "ok": true
}
```

**Errors:**
- `400`: Invalid event (validation failed)
- `413`: Request entity too large (>1MB)
- `500`: Internal server error

### GET /api/events

Retrieve events from log file.

**Query Parameters:**
- `tail`: Number of events from end (e.g., `?tail=1000`)
- `before_ts`: Get events before this timestamp (pagination)
- `limit`: Max events to return (default: 1000)

**Response:**
```json
{
  "events": [...],
  "next_before": 1704067100.0  // null if no more events
}
```

### GET /api/stats

Get system statistics.

**Response:**
```json
{
  "websocket": {
    "clients_open": 1,
    "queue_size": 0,
    "batches_sent": 100,
    "events_sent": 5000,
    "dropped_events_total": 0,
    "dropped_events_last_60s": 0
  },
  "watcher": {
    "last_offset": 12345,
    "carry_bytes": 0,
    "seen_event_ids": 5000,
    "consecutive_errors": 0
  },
  "file": {
    "current_size": 12345,
    "file_sig": {...}
  }
}
```

## Troubleshooting

### Duplicate Events

**Symptoms:** Same event appears twice in activity log

**Causes:**
1. File watcher reading same line twice
2. WebSocket broadcasting same event twice
3. Client receiving same event twice

**Debug:**
- Check console for `[FileWatcher] ⚠️ DUPLICATE DETECTED`
- Check console for `[WebSocket] ⚠️ DUPLICATE DETECTED`
- Check console for `[ActivityLog] Duplicate event detected`

**Fix:**
- Verify file watcher is only started once
- Check WebSocket duplicate detection window
- Verify activity log deduplication is working

### Missing Events

**Symptoms:** Events not appearing in UI

**Causes:**
1. Events not being written to file
2. File watcher not reading new events
3. WebSocket not broadcasting
4. Client not receiving events

**Debug:**
- Check events log file for new entries
- Check file watcher `last_offset` in stats
- Check WebSocket `queue_size` in stats
- Check browser console for WebSocket errors

### High Memory Usage

**Symptoms:** Application becomes slow or crashes

**Causes:**
1. Too many events in memory
2. Activity log not cleaning up old entries
3. WebSocket queue backing up

**Fix:**
- Reduce `MAX_EVENTS_IN_MEMORY` (default: 50,000)
- Reduce `maxEntries` in ActivityLog (default: 10,000)
- Check for backpressure (dropped events)

## Version History

- **v1:** Initial event system
  - Base event structure
  - Five event types
  - File watcher with offset tracking
  - WebSocket batching
  - Three-layer deduplication
