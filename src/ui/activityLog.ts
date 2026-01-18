import type { Event, FileTouchEvent, ToolCallEvent, AgentStateEvent, SessionEvent } from '../model/events.js';

export interface LogEntry {
  timestamp: number;
  mode: 'READ' | 'WRITE' | 'EXECUTING' | 'THOUGHT_COMPLETE' | 'RESPONSE_COMPLETE';
  evidence: string; // File path, command, tool name, etc.
  age: number; // Seconds since event
  sessionId: string; // Session ID for boundary detection
  isNew?: boolean; // Flag for flash animation
  isSessionBoundary?: boolean; // Flag for session separator
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
          grid-template-columns: 80px 100px 1fr;
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
        }
        .log-mode {
          font-weight: 600;
          text-transform: uppercase;
          font-size: 10px;
        }
        .log-mode.READ { color: #3b82f6; }
        .log-mode.WRITE { color: #f59e0b; }
        .log-mode.EXECUTING { color: #8b5cf6; }
        .log-mode.THOUGHT_COMPLETE { color: #a855f7; }
        .log-mode.RESPONSE_COMPLETE { color: #ec4899; }
        .log-evidence {
          color: rgba(200, 200, 220, 0.9);
          word-break: break-all;
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
    // Create unique key for deduplication: ts + type + identifying field
    const eventKey = this.getEventKey(event);
    if (this.seenEvents.has(eventKey)) {
      return; // Already seen this event, skip
    }
    this.seenEvents.add(eventKey);

    // Determine mode label from event and current state
    let mode: LogEntry['mode'] | null = null;
    let evidence = '';

    if (event.type === 'file_touch') {
      const ft = event as FileTouchEvent;
      mode = ft.kind === 'read' ? 'READ' : 'WRITE';
      evidence = ft.path;
    } else if (event.type === 'tool_call') {
      const tc = event as ToolCallEvent;
      const toolName = tc.tool || 'tool';
      const toolLower = toolName.toLowerCase();
      mode = 'EXECUTING';
      
      // For internet tool calls, show parsed info prominently (URL, query, etc.)
      // Internet calls don't have end phases, so never show phase label
      if (toolLower === 'internet' || toolLower.includes('internet') || toolLower.includes('web')) {
        // Internet tool: show parsed evidence (URL, query, etc.) prominently
        if (tc.command) {
          // Command field contains extracted URL/query from extractInternetEvidence
          evidence = tc.command;
        } else {
          // Fallback: just show tool name without phase
          evidence = toolName;
        }
      } else {
        // Other tools (terminal, etc.): show tool (phase) - command
        const phaseLabel = tc.phase === 'start' ? 'start' : 'end';
        if (tc.command) {
          evidence = `${toolName} (${phaseLabel}) - ${tc.command}`;
        } else {
          evidence = `${toolName} (${phaseLabel})`;
        }
      }
    } else if (event.type === 'agent_state') {
      const as = event as AgentStateEvent;
      if (as.state === 'thinking') {
        mode = 'THOUGHT_COMPLETE';
        evidence = 'thought complete';
      } else if (as.state === 'responding') {
        mode = 'RESPONSE_COMPLETE';
        evidence = 'response complete';
      }
    } else if (event.type === 'session') {
      const se = event as SessionEvent;
      if (se.state === 'start') {
        mode = 'EXECUTING'; // Session start
        evidence = 'session started';
      } else if (se.state === 'stop') {
        mode = 'EXECUTING'; // Session stop
        evidence = 'session ended';
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
        evidence,
        age: 0,
        sessionId: event.session_id,
        isNew: true, // Mark as new for flash animation
        isSessionBoundary: isSessionBoundary,
      };

      this.entries.push(entry);
      
      // Clear isNew flag after animation completes
      setTimeout(() => {
        entry.isNew = false;
      }, 1500);
      
      // Keep only last N entries (also clean up seenEvents set)
      if (this.entries.length > this.maxEntries) {
        const removed = this.entries.shift();
        if (removed) {
          // Note: We can't easily remove from seenEvents without storing keys per entry
          // But since we're keeping last N, old keys will naturally expire
          // For safety, periodically clean up if set gets too large
          if (this.seenEvents.size > this.maxEntries * 2) {
            // Rebuild seenEvents from current entries
            this.seenEvents.clear();
            this.entries.forEach((e, idx) => {
              // We'd need to store event keys with entries to rebuild properly
              // For now, just clear and let natural dedup handle it
            });
          }
        }
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
    const now = Date.now();
    
    // Update ages
    this.entries.forEach(entry => {
      entry.age = Math.floor((now - entry.timestamp) / 1000);
    });

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
    
    // Render only visible entries
    const visibleEntries = sortedEntries.slice(startIndex, endIndex);
    const entriesHtml = visibleEntries
      .map((entry, idx) => {
        const ageText = entry.age < 1 ? 'now' : entry.age < 60 ? `${entry.age}s` : `${Math.floor(entry.age / 60)}m`;
        const timeStr = new Date(entry.timestamp).toLocaleTimeString('en-US', { 
          hour12: false, 
          hour: '2-digit', 
          minute: '2-digit', 
          second: '2-digit' 
        });
        
        // Check if we need a session boundary before this entry
        // Show boundary OVER (above) session ended/started entries to clearly mark session boundaries
        const needsBoundary = entry.isSessionBoundary && 
                              (entry.evidence === 'session ended' || entry.evidence === 'session started');
        
        const newClass = entry.isNew ? ' new-entry' : '';
        
        return `
          ${needsBoundary ? '<div class="session-boundary"></div>' : ''}
          <div class="log-entry${newClass}">
            <div class="log-timestamp">${timeStr} (${ageText})</div>
            <div class="log-mode ${entry.mode}">${entry.mode}</div>
            <div class="log-evidence">${this.escapeHtml(entry.evidence)}</div>
          </div>
        `;
      })
      .join('');

    // Add spacer divs for virtual scrolling
    // Account for session boundaries in height calculation (each boundary adds 2px + 8px margin = 10px)
    let topBoundaryCount = 0;
    for (let i = 0; i < startIndex; i++) {
      const entry = sortedEntries[i];
      const hasBoundary = entry.isSessionBoundary && 
                          (entry.evidence === 'session ended' || entry.evidence === 'session started');
      if (hasBoundary) {
        topBoundaryCount++;
      }
    }
    const topSpacerHeight = startIndex * rowHeight + topBoundaryCount * 10;
    const topSpacer = startIndex > 0 ? `<div style="height: ${topSpacerHeight}px;"></div>` : '';
    
    // For bottom spacer, we don't need to count boundaries since they're after the visible area
    const bottomSpacerHeight = (sortedEntries.length - endIndex) * rowHeight;
    const bottomSpacer = endIndex < sortedEntries.length ? `<div style="height: ${bottomSpacerHeight}px;"></div>` : '';

    // Preserve scroll position
    const oldScrollTop = this.container.scrollTop;
    this.container.innerHTML = topSpacer + entriesHtml + bottomSpacer;
    this.container.scrollTop = oldScrollTop;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  clear() {
    this.entries = [];
    this.seenEvents.clear();
    this.render();
  }
}
