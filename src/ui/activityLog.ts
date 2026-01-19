import type { Event, FileTouchEvent, ToolCallEvent, AgentStateEvent, SessionEvent } from '../model/events.js';

export interface LogEntry {
  timestamp: number;
  mode: 'READ' | 'WRITE' | 'EXECUTING' | 'THOUGHT_COMPLETE' | 'RESPONSE_COMPLETE';
  name: string; // File name or tool name
  details: string; // Command details, args, etc.
  age: number; // Seconds since event (computed lazily for visible entries only)
  sessionId: string; // Session ID for boundary detection
  isNew?: boolean; // Flag for flash animation
  isSessionBoundary?: boolean; // Flag for session separator
  eventKey: string; // Store for seenEvents cleanup (Fix 4)
}

export class ActivityLog {
  private container: HTMLElement;
  private entries: LogEntry[] = [];
  private maxEntries = 10000; // Increased since we're virtualizing
  private renderScheduled = false;
  private seenEvents = new Set<string>(); // Track seen events to prevent duplicates
  private lastSessionId: string | null = null; // Track session changes for boundaries

  constructor(containerId: string) {
    const container = document.getElementById(containerId);
    if (!container) {
      throw new Error(`Container not found: ${containerId}`);
    }
    this.container = container;
    this.setupStyles();
    
    // Throttle render on scroll
    this.container.addEventListener('scroll', () => {
      if (!this.renderScheduled) {
        this.renderScheduled = true;
        requestAnimationFrame(() => {
          this.render();
          this.renderScheduled = false;
        });
      }
    });
  }

  private setupStyles() {
    // Add styles for the activity log
    if (!document.getElementById('activity-log-styles')) {
      const style = document.createElement('style');
      style.id = 'activity-log-styles';
      style.textContent = `
        #activityLog {
          width: 100%;
          height: 100%;
          overflow-y: auto;
          overflow-x: hidden;
          font-family: 'SF Mono', 'Monaco', 'Cascadia Code', 'Roboto Mono', monospace;
          font-size: 11px;
          background: rgba(10, 10, 15, 0.95);
          color: rgba(200, 200, 220, 0.9);
        }
        .log-entry {
          display: grid;
          grid-template-columns: 160px 100px 200px 1fr;
          gap: 12px;
          padding: 6px 12px;
          border-bottom: 1px solid rgba(100, 100, 120, 0.1);
          transition: background 0.1s;
          min-height: 28px;
          box-sizing: border-box;
        }
        .log-entry:hover {
          background: rgba(100, 100, 120, 0.1);
        }
        .log-timestamp {
          color: rgba(150, 150, 170, 0.7);
          font-size: 10px;
          white-space: nowrap;
        }
        .log-mode {
          font-weight: 600;
          text-transform: uppercase;
          font-size: 10px;
          white-space: nowrap;
        }
        .log-mode.READ { color: #3b82f6; }
        .log-mode.WRITE { color: #f59e0b; }
        .log-mode.EXECUTING { color: #8b5cf6; }
        .log-mode.THOUGHT_COMPLETE { color: #a855f7; }
        .log-mode.RESPONSE_COMPLETE { color: #ec4899; }
        .log-name {
          color: rgba(200, 200, 220, 0.9);
          font-size: 11px;
          word-break: break-word;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .log-details {
          color: rgba(150, 150, 170, 0.8);
          font-size: 10px;
          word-break: break-all;
          font-family: 'SF Mono', 'Monaco', 'Cascadia Code', 'Roboto Mono', monospace;
        }
        .log-header {
          display: grid;
          grid-template-columns: 160px 100px 200px 1fr;
          gap: 12px;
          padding: 6px 12px;
          border-bottom: 2px solid rgba(100, 100, 120, 0.3);
          background: rgba(15, 15, 20, 0.95);
          position: sticky;
          top: 0;
          z-index: 10;
          min-height: 28px;
          box-sizing: border-box;
        }
        .log-header-cell {
          color: rgba(150, 150, 170, 0.6);
          font-size: 9px;
          text-transform: lowercase;
          font-weight: 600;
          letter-spacing: 0.5px;
        }
        .log-entry.new-entry {
          animation: flashEntry 1.5s ease-out;
        }
        @keyframes flashEntry {
          0% {
            background: rgba(255, 255, 255, 0.15);
          }
          100% {
            background: transparent;
          }
        }
        .session-boundary {
          height: 2px;
          background: linear-gradient(to right, transparent, #fbbf24, transparent);
          margin: 4px 0;
          opacity: 0.6;
        }
      `;
      document.head.appendChild(style);
    }
  }

  addEvent(event: Event, currentMode: string) {
    // Use canonical event ID if available, otherwise fall back to generated key
    const eventKey = event.id || this.getEventKey(event);
    if (this.seenEvents.has(eventKey)) {
      // Log duplicate detection for debugging
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[ActivityLog] Duplicate event detected: ${eventKey} - skipping`);
      }
      return; // Already seen this event, skip
    }
    this.seenEvents.add(eventKey);

    // Determine mode label from event and current state
    let mode: LogEntry['mode'] | null = null;
    let name = '';
    let details = '';

    if (event.type === 'file_touch') {
      const ft = event as FileTouchEvent;
      mode = ft.kind === 'read' ? 'READ' : 'WRITE';
      // Extract just the filename from the path
      const pathParts = ft.path.split(/[/\\]/);
      name = pathParts[pathParts.length - 1] || ft.path;
      // Show directory path as details (if different from filename)
      const dirPath = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';
      details = dirPath;
    } else if (event.type === 'tool_call') {
      const tc = event as ToolCallEvent;
      const toolName = tc.tool || 'tool';
      const toolLower = toolName.toLowerCase();
      mode = 'EXECUTING';
      
      // Show tool name in name column, command/details in details column
      if (toolLower === 'mcp') {
        // MCP: show "mcp" as name, (start/end) server:tool (args) as details
        name = 'mcp';
        const phaseLabel = tc.phase === 'start' ? 'start' : 'end';
        if (tc.command) {
          details = `(${phaseLabel}) ${tc.command}`;
        } else {
          details = `(${phaseLabel})`;
        }
      } else if (toolLower === 'internet' || toolLower.includes('internet') || toolLower.includes('web')) {
        // Internet: show "internet" as name, URL/query as details
        name = 'internet';
        details = tc.command || '';
      } else {
        // Other tools (terminal, etc.): show tool name, command as details
        name = toolName;
        const phaseLabel = tc.phase === 'start' ? 'start' : 'end';
        if (tc.command) {
          details = `(${phaseLabel}) ${tc.command}`;
        } else {
          details = `(${phaseLabel})`;
        }
      }
    } else if (event.type === 'agent_state') {
      const as = event as AgentStateEvent;
      if (as.state === 'thinking') {
        mode = 'THOUGHT_COMPLETE';
        name = 'thought';
        details = 'complete';
      } else if (as.state === 'responding') {
        mode = 'RESPONSE_COMPLETE';
        name = 'response';
        details = 'complete';
      }
    } else if (event.type === 'session') {
      const se = event as SessionEvent;
      if (se.state === 'start') {
        mode = 'EXECUTING';
        name = 'session';
        details = 'started';
      } else if (se.state === 'stop') {
        mode = 'EXECUTING';
        name = 'stop';
        details = '';
      }
    }

    // Only add entries for events that have a mode
    if (mode) {
      // Only mark as session boundary if it's an actual session start/stop event
      const isSessionBoundary = event.type === 'session';
      
      // Update last session ID
      if (event.type === 'session' || this.lastSessionId === null) {
        this.lastSessionId = event.session_id;
      }
      
      const entry: LogEntry = {
        timestamp: event.ts * 1000, // Convert to milliseconds
        mode,
        name,
        details,
        age: 0, // Will be computed lazily for visible entries only
        sessionId: event.session_id,
        isNew: true, // Mark as new for flash animation
        isSessionBoundary: isSessionBoundary,
        eventKey: eventKey, // Store for seenEvents cleanup
      };

      this.entries.push(entry);
      
      // Clear isNew flag after animation completes
      setTimeout(() => {
        entry.isNew = false;
      }, 1500);
      
      // Keep only last N entries (also clean up seenEvents set)
      if (this.entries.length > this.maxEntries) {
        const removed = this.entries.shift();
        if (removed && removed.eventKey) {
          // Mechanical cleanup: remove key when entry is removed
          this.seenEvents.delete(removed.eventKey);
        }
      }
      
      // Periodic safety check: if seenEvents gets too large, rebuild from entries
      if (this.seenEvents.size > this.maxEntries * 1.5) {
        this.rebuildSeenEvents();
      }

      // Schedule render (throttled)
      if (!this.renderScheduled) {
        this.renderScheduled = true;
        requestAnimationFrame(() => {
          this.render();
          this.renderScheduled = false;
        });
      }
    }
  }

  private getEventKey(event: Event): string {
    // Create unique key: ts (with millisecond precision) + type + identifying field
    const ts = event.ts.toFixed(3); // 3 decimal places for millisecond precision
    
    if (event.type === 'file_touch') {
      const ft = event as FileTouchEvent;
      return `${ts}:${event.type}:${ft.kind}:${ft.path}`;
    } else if (event.type === 'tool_call') {
      const tc = event as ToolCallEvent;
      // Include phase and tool name in key to distinguish start/end as separate events
      const identifier = tc.command || '';
      return `${ts}:${event.type}:${tc.phase}:${tc.tool}:${identifier}`;
    } else if (event.type === 'agent_state') {
      const as = event as AgentStateEvent;
      return `${ts}:${event.type}:${as.state}`;
    } else if (event.type === 'session') {
      const se = event as SessionEvent;
      return `${ts}:${event.type}:${se.state}`;
    }
    
    // Fallback for unknown events
    return `${ts}:${event.type}:${event.session_id}`;
  }

  private render() {
    const now = Date.now(); // Cache timestamp once per frame
    
    // Virtual scrolling: only render visible rows + buffer
    const containerHeight = this.container.clientHeight || 600;
    const rowHeight = 28;
    const bufferRows = 10; // Render extra rows above/below viewport
    const visibleRows = Math.ceil(containerHeight / rowHeight) + bufferRows * 2;
    const scrollTop = this.container.scrollTop;
    const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - bufferRows);
    const endIndex = Math.min(this.entries.length, startIndex + visibleRows);

    // Render entries (newest first in array, but display oldest at top)
    const sortedEntries = this.entries.slice().reverse();
    
    // Render only visible entries - calculate age ONLY for visible entries
    const visibleEntries = sortedEntries.slice(startIndex, endIndex);
    
    // Use DocumentFragment for efficient DOM updates
    const fragment = document.createDocumentFragment();
    
    // Create header
    const header = document.createElement('div');
    header.className = 'log-header';
    header.innerHTML = `
      <div class="log-header-cell">time</div>
      <div class="log-header-cell">zone</div>
      <div class="log-header-cell">name</div>
      <div class="log-header-cell">details</div>
    `;
    fragment.appendChild(header);
    
    // Add top spacer if needed
    if (startIndex > 0) {
      let topBoundaryCount = 0;
      for (let i = 0; i < startIndex; i++) {
        const entry = sortedEntries[i];
        const hasBoundary = entry.isSessionBoundary && 
                            (entry.name === 'stop' || entry.details === 'started');
        if (hasBoundary) {
          topBoundaryCount++;
        }
      }
      const topSpacerHeight = startIndex * rowHeight + topBoundaryCount * 10;
      const topSpacer = document.createElement('div');
      topSpacer.style.height = `${topSpacerHeight}px`;
      fragment.appendChild(topSpacer);
    }
    
    // Create visible entries
    for (const entry of visibleEntries) {
      // Calculate age ONLY for visible entries (lazy computation)
      entry.age = Math.floor((now - entry.timestamp) / 1000);
      
      const ageText = entry.age < 1 ? 'now' : entry.age < 60 ? `${entry.age}s` : `${Math.floor(entry.age / 60)}m`;
      const timeStr = new Date(entry.timestamp).toLocaleTimeString('en-US', { 
        hour12: false, 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit' 
      });
      
      // Check if we need a session boundary before this entry
      const needsBoundary = entry.isSessionBoundary && 
                            (entry.name === 'stop' || entry.details === 'started');
      
      if (needsBoundary) {
        const boundary = document.createElement('div');
        boundary.className = 'session-boundary';
        fragment.appendChild(boundary);
      }
      
      const entryDiv = document.createElement('div');
      entryDiv.className = `log-entry${entry.isNew ? ' new-entry' : ''}`;
      entryDiv.innerHTML = `
        <div class="log-timestamp">${timeStr} (${ageText})</div>
        <div class="log-mode ${entry.mode}">${entry.mode}</div>
        <div class="log-name">${this.escapeHtml(entry.name)}</div>
        <div class="log-details">${this.escapeHtml(entry.details)}</div>
      `;
      fragment.appendChild(entryDiv);
    }
    
    // Add bottom spacer if needed
    if (endIndex < sortedEntries.length) {
      const bottomSpacerHeight = (sortedEntries.length - endIndex) * rowHeight;
      const bottomSpacer = document.createElement('div');
      bottomSpacer.style.height = `${bottomSpacerHeight}px`;
      fragment.appendChild(bottomSpacer);
    }

    // Preserve scroll position
    const oldScrollTop = this.container.scrollTop;
    
    // Replace container content with fragment (more efficient than innerHTML)
    this.container.innerHTML = '';
    this.container.appendChild(fragment);
    this.container.scrollTop = oldScrollTop;
  }
  
  private rebuildSeenEvents() {
    // Rebuild seenEvents from current entries (safety check)
    this.seenEvents.clear();
    for (const entry of this.entries) {
      if (entry.eventKey) {
        this.seenEvents.add(entry.eventKey);
      }
    }
  }

  private escapeHtml(text: string): string {
    // Efficient HTML escaping using regex (faster than DOM-based)
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  clear() {
    this.entries = [];
    this.seenEvents.clear();
    this.render();
  }
}
