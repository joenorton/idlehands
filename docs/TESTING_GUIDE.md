# Performance Improvements Testing Guide

This guide helps you test the latest performance improvements implemented in Idlehands.

## Quick Start

1. **Start the server**:
   ```bash
   npm start
   ```

2. **Open the UI**: Navigate to `http://localhost:8765`

3. **Monitor stats**: Open `http://localhost:8765/api/stats` in another tab or use curl:
   ```bash
   curl http://localhost:8765/api/stats | jq
   ```

## What to Test

### 1. File Watcher Performance (Fix 1)

**What was improved:**
- Async file operations (no blocking)
- Single-flight queue (prevents race conditions)
- Offset-based parsing (no event loss/duplication)
- Partial-line carry handling

**How to test:**

1. **Rapid event generation**:
   ```bash
   # Generate many events quickly
   for i in {1..1000}; do
     node dist/cli/log.js
     sleep 0.01  # 10ms between events (~100 events/sec)
   done
   ```

2. **Check server console** for:
   - No "Offset regression" errors
   - No "Duplicate event_id detected" errors
   - No "Carry buffer contains newline" errors
   - Events emitted in order

3. **Check stats endpoint** (`/api/stats`):
   ```json
   {
     "watcher": {
       "last_offset": 12345,        // Should increase monotonically
       "carry_bytes": 0,             // Should be 0 or small (< 1000)
       "seen_event_ids": 1234,       // Should match number of events
       "consecutive_errors": 0       // Should be 0
     }
   }
   ```

4. **File truncation test**:
   ```bash
   # While server is running, truncate the events file
   echo "" > ~/.idlehands/events.ndjson
   # Server should detect truncation and reset cleanly
   # Check console for "File truncated or rotated" message
   ```

### 2. WebSocket Batching (Fix 2)

**What was improved:**
- Events batched (50ms window, max 100 events)
- Leading edge send (first event/batch sent immediately)
- Backpressure handling with gap events
- Duplicate detection

**How to test:**

1. **Watch for batching in server console**:
   - Look for: `📡 WebSocket: sent batch of X event(s)`
   - First event should appear quickly (leading edge)
   - Subsequent events should be batched

2. **Check stats endpoint**:
   ```json
   {
     "websocket": {
       "clients_open": 1,
       "queue_size": 0,                    // Should stay low (< 10)
       "batch_window_ms": 50,
       "batches_sent": 123,                // Should increase
       "events_sent": 1234,                 // Total events sent
       "dropped_events_total": 0,          // Should be 0 normally
       "dropped_events_last_60s": 0,       // Should be 0 normally
       "drop_rate_percent": 0              // Should be 0 normally
     }
   }
   ```

3. **Test backpressure** (if possible):
   - Generate events faster than client can process
   - Watch for gap events in UI
   - Check `dropped_events_total` in stats
   - UI should show gap notifications

4. **Check browser console** for:
   - WebSocket messages arriving as batches: `{ type: 'batch', events: [...] }`
   - No duplicate events (check event IDs)

### 3. Activity Log Virtualization (Fix 3)

**What was improved:**
- Only visible entries rendered
- Age computed lazily (only for visible entries)
- DocumentFragment for efficient DOM updates
- Virtual scrolling

**How to test:**

1. **Generate many events** (10,000+):
   ```bash
   for i in {1..10000}; do
     node dist/cli/log.js
   done
   ```

2. **Check browser DevTools**:
   - Open Performance tab
   - Record while scrolling activity log
   - Should maintain 60fps
   - Check "FPS" meter in DevTools

3. **Check DOM**:
   - Inspect activity log container
   - Should only have ~50-100 DOM nodes (visible rows + buffer)
   - Not 10,000 nodes!

4. **Scroll performance**:
   - Scroll up/down rapidly
   - Should be smooth, no jank
   - Age values should update correctly

### 4. Memory Leak Fix (Fix 4)

**What was improved:**
- `seenEvents` Set cleaned up when entries removed
- Bounded memory growth

**How to test:**

1. **Long-running session**:
   - Let server run for 1+ hour
   - Generate events continuously

2. **Check memory usage**:
   ```bash
   # Monitor Node.js process memory
   # On Windows (PowerShell):
   Get-Process node | Select-Object ProcessName, @{Name="Memory(MB)";Expression={[math]::Round($_.WS/1MB,2)}}
   
   # Or use Task Manager
   ```

3. **Check stats**:
   ```json
   {
     "watcher": {
       "seen_event_ids": 10000  // Should cap at maxEntries (10,000)
     }
   }
   ```

4. **Memory should stay bounded**:
   - Should not grow unbounded
   - Target: < 100MB for 10K events

## Performance Benchmarks

### Target Metrics (from plan):

- **Cold start** (`/api/events?tail=1000`): < 200ms
- **File watcher latency**: < 50ms end-to-end (fschange → websocket) p95
- **UI frame rate**: 60fps with 10,000 activity log entries
- **Memory usage**: < 100MB for typical sessions
- **WebSocket queue**: Should stay low (< 10 events)

### How to measure:

1. **Cold start latency**:
   ```bash
   # Time the API call
   time curl http://localhost:8765/api/events?tail=1000
   ```

2. **Frame rate**:
   - Open Chrome DevTools → Performance tab
   - Record while using UI
   - Check FPS graph (should be ~60fps)

3. **Memory**:
   - Use Task Manager or `Get-Process` (Windows)
   - Monitor over time

## Manual Testing Checklist

- [ ] **Rapid events**: Generate 100+ events/sec, verify no duplicates
- [ ] **File truncation**: Truncate events file, verify clean reset
- [ ] **WebSocket batching**: Check console for batch messages
- [ ] **Leading edge**: First event appears quickly (< 100ms)
- [ ] **Virtual scrolling**: 10K+ entries, smooth scrolling, 60fps
- [ ] **Memory**: Long session, memory stays bounded
- [ ] **Stats endpoint**: All metrics look reasonable
- [ ] **No errors**: Check server console for assertion violations
- [ ] **Gap events**: If backpressure occurs, gap events appear in UI

## Common Issues to Watch For

1. **"Offset regression" errors**: File watcher offset tracking broken
2. **"Duplicate event_id" errors**: Event deduplication broken
3. **"Carry buffer contains newline"**: Line parsing broken
4. **High `queue_size`**: Client can't keep up (backpressure)
5. **High `dropped_events_total`**: Events being dropped
6. **Low FPS**: UI rendering performance issue
7. **Memory growth**: Memory leak not fixed

## Quick Test Script

Save this as `test-performance.ps1` (PowerShell):

```powershell
# Quick performance test
Write-Host "Testing Idlehands Performance..." -ForegroundColor Green

# 1. Check stats endpoint
Write-Host "`n1. Checking stats endpoint..." -ForegroundColor Yellow
$stats = Invoke-RestMethod -Uri "http://localhost:8765/api/stats"
Write-Host "WebSocket queue size: $($stats.websocket.queue_size)"
Write-Host "Dropped events: $($stats.websocket.dropped_events_total)"
Write-Host "Watcher offset: $($stats.watcher.last_offset)"
Write-Host "Seen event IDs: $($stats.watcher.seen_event_ids)"

# 2. Generate test events
Write-Host "`n2. Generating 100 test events..." -ForegroundColor Yellow
for ($i = 1; $i -le 100; $i++) {
    node dist/cli/log.js
    Start-Sleep -Milliseconds 10
}

# 3. Check stats again
Write-Host "`n3. Checking stats after events..." -ForegroundColor Yellow
Start-Sleep -Seconds 2
$stats2 = Invoke-RestMethod -Uri "http://localhost:8765/api/stats"
Write-Host "Events sent: $($stats2.websocket.events_sent)"
Write-Host "Batches sent: $($stats2.websocket.batches_sent)"

Write-Host "`n✅ Test complete!" -ForegroundColor Green
```

Run with:
```powershell
.\test-performance.ps1
```

## Next Steps

If all tests pass:
- ✅ Performance improvements are working
- ✅ Ready for production use

If issues found:
- Check server console for error messages
- Review stats endpoint metrics
- Check browser console for client-side errors
- Refer to `PERFORMANCE_FIXES_PLAN.md` for implementation details
