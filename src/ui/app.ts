import { MapRenderer } from './map.js';
import { AgentController } from './agent.js';
import { Timeline } from './timeline.js';
import { ActivityLog } from './activityLog.js';
import { AgentStateMachine, type AgentState } from './state.js';
import type { Event, FileTouchEvent, ToolCallEvent, SessionEvent, AgentStateEvent } from '../model/events.js';
import type { Layout } from '../server/layout.js';

interface AppState {
  layout: Layout | null;
  events: Event[];
  isLive: boolean;
  lastEventTime: number;
  eventCount: number;
  eventsPerSecond: number;
  idleSeconds: number;
  scopeWidth: number; // Distinct files touched in last N seconds
}

// Maximum number of events to keep in memory
const MAX_EVENTS_IN_MEMORY = 50000;

class App {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ws: WebSocket | null = null;
  private mapRenderer: MapRenderer;
  private agentController: AgentController;
  private timeline: Timeline;
  private sharedMapRenderer: MapRenderer;
  private stateMachine: AgentStateMachine;
  private activityLog: ActivityLog;
  private state: AppState = {
    layout: null,
    events: [],
    isLive: true,
    lastEventTime: 0,
    eventCount: 0,
    eventsPerSecond: 0,
    idleSeconds: 0,
    scopeWidth: 0,
  };
  
  private eventRateWindow: number[] = [];
  private lastUpdateTime = Date.now();
  private recentFiles = new Set<string>(); // Files touched in last 30 seconds
  private activeToolCalls = new Map<string, { startTime: number; tool: string; command?: string }>(); // Track tool calls by key
  private toolCallTimeout = 30000; // 30 seconds timeout for incomplete tool calls
  private isDisconnected = false;
  private isSessionEnded = false; // Track if current session has ended
  private renderScheduled = false; // One render per animation frame

  constructor() {
    this.canvas = document.getElementById('canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.sharedMapRenderer = new MapRenderer(this.canvas, this.ctx);
    this.mapRenderer = this.sharedMapRenderer;
    this.agentController = new AgentController(this.canvas, this.ctx, this.sharedMapRenderer);
    this.timeline = new Timeline(
      document.getElementById('timeline')!
    );
    this.activityLog = new ActivityLog('activityLog');

    // Initialize state machine with transition handler
    this.stateMachine = new AgentStateMachine((transition) => {
      // Move agent on state transition (only activity zones, not agent states)
      this.agentController.moveToActivityZone(`zone:${transition.to}`, false);
      // Update active zone for visual hierarchy
      this.mapRenderer.setActiveZone(`zone:${transition.to}`);
      // Clear agent state (not in an agent state)
      this.agentController.setAgentState(null);
    });

    this.setupControls();
    this.setupCanvas();
    this.loadLayout();
    this.loadEvents(1000); // Load only last 1000 events initially
    this.connectWebSocket();
    this.startRenderLoop();
  }

  private setupCanvas() {
    const resize = () => {
      // Canvas is in a flex container (40% width), size it to fit
      const canvasContainer = document.getElementById('canvasContainer');
      if (canvasContainer) {
        // Set canvas size to match container (device pixel ratio for crisp rendering)
        const dpr = window.devicePixelRatio || 1;
        const rect = canvasContainer.getBoundingClientRect();
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.scale(dpr, dpr);
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
      } else {
        // Fallback to window size if parent not found
        const dpr = window.devicePixelRatio || 1;
        const width = window.innerWidth * 0.4;
        const height = window.innerHeight - 200; // Account for controls and timeline
        this.canvas.width = width * dpr;
        this.canvas.height = height * dpr;
        this.ctx.scale(dpr, dpr);
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
      }
      this.render();
    };
    window.addEventListener('resize', resize);
    // Use ResizeObserver to watch container size changes
    const canvasContainer = document.getElementById('canvasContainer');
    if (canvasContainer) {
      const resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvasContainer);
    }
    // Initial resize after a short delay to ensure DOM is ready
    setTimeout(resize, 10);
  }

  private setupControls() {
    const loadMoreBtn = document.getElementById('loadMoreEvents')!;
    
    loadMoreBtn.addEventListener('click', () => {
      this.loadMoreEvents();
    });
  }

  private async loadLayout() {
    try {
      const response = await fetch('/api/layout');
      const layoutData = await response.json() as Layout;
      this.state.layout = layoutData;
      
      this.mapRenderer.setLayout(layoutData);
      this.agentController.setLayout(layoutData);
      this.render();
    } catch (error) {
      console.error('Failed to load layout:', error);
      this.updateStatus('Failed to load layout');
    }
  }

  private async loadEvents(tail: number = 1000) {
    try {
      const response = await fetch(`/api/events?tail=${tail}`);
      const data = await response.json() as { events: Event[]; next_before: number | null };
      const events = data.events;
      
      this.state.events = events;
      this.timeline.setEvents(events);
      
      // Store pagination cursor
      (this.state as any).nextBefore = data.next_before;
      
      // Process loaded events to build state and evidence
      for (const event of events) {
        this.stateMachine.processEvent(event);
        // Add to activity log
        const currentState = this.stateMachine.getState();
        this.activityLog.addEvent(event, currentState || '');
        
        // Track active file from file_touch events
        if (event.type === 'file_touch') {
          const ft = event as FileTouchEvent;
          this.agentController.setActiveFile(ft.path);
        }
      }
      
      // Check the most recent session event to determine session state
      // Events are in reverse chronological order (newest first)
      let sessionEnded = false;
      if (events.length > 0) {
        // Find the most recent session event
        for (const event of events) {
          if (event.type === 'session') {
            const se = event as SessionEvent;
            sessionEnded = se.state === 'stop';
            break; // Found most recent session event, use its state
          }
        }
        // If no session event found but we have events, assume session is active
      } else {
        // No events at all - treat as ended
        sessionEnded = true;
      }
      this.isSessionEnded = sessionEnded;
      
      if (this.isSessionEnded || events.length === 0) {
        // Session has ended or no events - agent should be at home
        this.agentController.setActiveFile(null);
        this.agentController.moveToHome(true);
        this.mapRenderer.setActiveZone(null);
      } else if (events.length > 0) {
        // Move agent to current state (only activity zones)
        const currentState = this.stateMachine.getState();
        if (currentState) {
          this.agentController.moveToActivityZone(`zone:${currentState}`, true);
          this.mapRenderer.setActiveZone(`zone:${currentState}`);
        } else {
          // No current state - go home
          this.agentController.setActiveFile(null);
          this.agentController.moveToHome(true);
          this.mapRenderer.setActiveZone(null);
        }
      }
      
      this.render();
      this.updateStatus(`Loaded ${events.length} events${data.next_before ? ' (more available)' : ''}`);
      this.updateLoadMoreButton();
    } catch (error) {
      console.error('Failed to load events:', error);
      this.updateStatus('Failed to load events');
    }
  }

  private async loadMoreEvents() {
    const nextBefore = (this.state as any).nextBefore;
    if (!nextBefore) {
      return; // No more events
    }

    try {
      const response = await fetch(`/api/events?before_ts=${nextBefore}&limit=1000`);
      const data = await response.json() as { events: Event[]; next_before: number | null };
      const events = data.events;
      
      if (events.length === 0) {
        (this.state as any).nextBefore = null;
        this.updateLoadMoreButton();
        return;
      }

      // Prepend older events (they're already in reverse chronological order from API)
      this.state.events = [...events, ...this.state.events];
      this.timeline.setEvents(this.state.events);
      
      // Store pagination cursor
      (this.state as any).nextBefore = data.next_before;
      
      // Process loaded events to build state (in chronological order)
      for (const event of events.reverse()) {
        this.stateMachine.processEvent(event);
        const currentState = this.stateMachine.getState();
        this.activityLog.addEvent(event, currentState || '');
        
        // Track active file from file_touch events
        if (event.type === 'file_touch') {
          const ft = event as FileTouchEvent;
          this.agentController.setActiveFile(ft.path);
        }
      }
      
      this.render();
      this.updateStatus(`Loaded ${events.length} more events${data.next_before ? ' (more available)' : ''}`);
      this.updateLoadMoreButton();
    } catch (error) {
      console.error('Failed to load more events:', error);
      this.updateStatus('Failed to load more events');
    }
  }

  private updateLoadMoreButton() {
    const button = document.getElementById('loadMoreEvents');
    if (button) {
      const nextBefore = (this.state as any).nextBefore;
      if (nextBefore) {
        button.style.display = 'block';
        button.textContent = 'Load More Events';
      } else {
        button.style.display = 'none';
      }
    }
  }

  private connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onopen = () => {
      this.updateStatus('Connected');
      this.state.isLive = true;
      this.isDisconnected = false;
      this.render();
    };

    this.ws.onmessage = (event) => {
      let message: any;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
        console.error('Raw message:', event.data);
        return; // Ignore malformed messages
      }
      
      // Handle batches or single events
      let eventsToProcess: Event[] = [];
      
      if (message.type === 'batch' && Array.isArray(message.events)) {
        // Batch message
        eventsToProcess = message.events;
      } else {
        // Single event (backward compatibility)
        eventsToProcess = [message as Event];
      }
      
      // Process all events in batch
      for (const newEvent of eventsToProcess) {
        // Handle gap events specially
        if (newEvent.type === 'unknown' && (newEvent as any).gap_type === 'dropped') {
          const gap = newEvent as any;
          console.warn(`[App] Gap detected: ${gap.dropped_count} events dropped`);
          // Show gap in UI (can be added to activity log as special entry)
          this.updateStatus(`⚠️ ${gap.dropped_count} events dropped`);
          // Don't process gap as normal event, but add to events array for visibility
          this.state.events.push(newEvent);
          continue;
        }
        
        this.state.events.push(newEvent);
      
        // Enforce event array size limit to prevent memory issues
        if (this.state.events.length > MAX_EVENTS_IN_MEMORY) {
          // Remove oldest events (keep newest)
          const eventsToRemove = this.state.events.length - MAX_EVENTS_IN_MEMORY;
          this.state.events = this.state.events.slice(eventsToRemove);
          console.warn(`[App] Removed ${eventsToRemove} old events to maintain memory limit`);
        }
        
        this.timeline.addEvent(newEvent);
        
        // Update stats
        const now = Date.now();
        this.state.lastEventTime = newEvent.ts;
        this.state.eventCount++;
        this.eventRateWindow.push(now);
        // Keep only last second of events
        this.eventRateWindow = this.eventRateWindow.filter(t => now - t < 1000);
        this.state.eventsPerSecond = this.eventRateWindow.length;
        this.state.idleSeconds = 0;
        
        // Handle tool call lifecycle
        if (newEvent.type === 'tool_call') {
          const tc = newEvent as ToolCallEvent;
          const toolKey = `${tc.tool}:${tc.command || ''}`;
          
          if (tc.phase === 'start') {
            // Track tool call start
            this.activeToolCalls.set(toolKey, {
              startTime: newEvent.ts * 1000,
              tool: tc.tool,
              command: tc.command,
            });
            
            // Clear active file label for tool calls
            this.agentController.setActiveFile(null);
            
            // Set timeout to mark as incomplete if no end event
            setTimeout(() => {
              if (this.activeToolCalls.has(toolKey)) {
                // Tool call is incomplete/hung - mark it but don't keep UI stuck
                console.warn(`[App] Tool call incomplete after timeout: ${tc.tool}`);
                this.activeToolCalls.delete(toolKey);
                // Don't transition state - let it clear naturally
              }
            }, this.toolCallTimeout);
          } else if (tc.phase === 'end') {
            // Clear tool call tracking
            this.activeToolCalls.delete(toolKey);
          }
        }
        
        // Handle file_touch events - update active file label
        if (newEvent.type === 'file_touch') {
          const ft = newEvent as FileTouchEvent;
          this.agentController.setActiveFile(ft.path);
        }
        
        // Handle session boundaries
        if (newEvent.type === 'session') {
          const se = newEvent as SessionEvent;
          if (se.state === 'stop') {
            // Mark session as ended
            this.isSessionEnded = true;
            // Clear all active tool calls on session stop
            this.activeToolCalls.clear();
            // Clear active file label
            this.agentController.setActiveFile(null);
            // Move agent to home
            this.agentController.moveToHome(false);
            this.mapRenderer.setActiveZone(null);
          } else if (se.state === 'start') {
            // Mark session as active when a new session starts
            this.isSessionEnded = false;
          }
        }
        
        // Handle agent_state events as ephemeral beacons (don't cause state transitions)
        if (newEvent.type === 'agent_state') {
          const as = newEvent as AgentStateEvent;
          if (as.state === 'thinking' || as.state === 'responding') {
            // Show ephemeral beacon (emoji bubble) but don't move agent
            this.agentController.setAgentState(as.state as 'thinking' | 'responding');
          }
        }
        
        // Process event through state machine (handles transitions for activity events only)
        const stateChanged = this.stateMachine.processEvent(newEvent);
        const currentState = this.stateMachine.getState();
        
        // Update active zone if state changed (only for activity zones)
        if (stateChanged) {
          if (currentState) {
            this.mapRenderer.setActiveZone(`zone:${currentState}`);
          }
        }

        // Check if event should trigger pulse on current zone (even if state didn't change)
        if (!stateChanged && currentState) {
          const eventZone = this.getZoneForEvent(newEvent);
          const currentZoneId = `zone:${currentState}`;
          
          // If event maps to current zone, trigger pulse
          if (eventZone === currentZoneId) {
            this.mapRenderer.triggerZonePulse(currentZoneId);
          }
        }

        // Add event to activity log (deduplication handled in ActivityLog)
        this.activityLog.addEvent(newEvent, currentState || '');
      }
      
      // Update scope width
      this.state.scopeWidth = this.recentFiles.size;
      
      this.updateStatusPanel();
      
      // Schedule render (only once per animation frame)
      if (!this.renderScheduled) {
        this.renderScheduled = true;
        requestAnimationFrame(() => {
          this.render();
          this.renderScheduled = false;
        });
      }
    };

    this.ws.onerror = () => {
      this.updateStatus('WebSocket error');
      this.isDisconnected = true;
      this.render();
    };

    this.ws.onclose = () => {
      this.updateStatus('Disconnected');
      this.state.isLive = false;
      this.isDisconnected = true;
      // Clear active tool calls on disconnect
      this.activeToolCalls.clear();
      this.render();
      // Try to reconnect after 3 seconds
      setTimeout(() => this.connectWebSocket(), 3000);
    };
  }

  // Removed routeEvidence - all evidence now goes to activity log

  // Map event type to zone ID (returns null if event doesn't map to a zone)
  private getZoneForEvent(event: Event): string | null {
    if (event.type === 'file_touch') {
      const ft = event as FileTouchEvent;
      if (ft.kind === 'read') {
        return 'zone:reading';
      } else if (ft.kind === 'write') {
        return 'zone:writing';
      }
    } else if (event.type === 'tool_call') {
      const tc = event as ToolCallEvent;
      if (tc.phase === 'start') {
        return 'zone:executing';
      }
      // tool_call 'end' doesn't map to a zone (returns to previous state)
    }
    // agent_state, session events don't map to zones
    return null;
  }

  private updateStatus(message: string) {
    const status = document.getElementById('status')!;
    status.textContent = message;
  }

  private updateStatusPanel() {
    const lastEventEl = document.getElementById('lastEvent')!;
    const eventsPerSecEl = document.getElementById('eventsPerSec')!;
    const idleSecondsEl = document.getElementById('idleSeconds')!;
    
    // Show "session ended" if session has ended, otherwise show current activity mode
    if (this.isSessionEnded) {
      lastEventEl.textContent = 'session ended';
    } else {
      // Show current activity mode from state machine
      const currentState = this.stateMachine.getState();
      const dwellTime = Math.floor(this.stateMachine.getDwellTime());
      
      lastEventEl.textContent = currentState ? `${currentState} (${dwellTime}s)` : '-';
    }
    
    eventsPerSecEl.textContent = this.state.eventsPerSecond.toFixed(1);
    
    // Update idle time (time since last event)
    const now = Date.now() / 1000;
    if (this.state.lastEventTime > 0) {
      this.state.idleSeconds = Math.floor(now - this.state.lastEventTime);
    }
    idleSecondsEl.textContent = this.state.idleSeconds.toString();
  }

  private render() {
    if (!this.state.layout) {
      return;
    }

    // Clear canvas with gradient background
    const bgGradient = this.ctx.createLinearGradient(0, 0, this.canvas.width, this.canvas.height);
    bgGradient.addColorStop(0, '#0a0a0f');
    bgGradient.addColorStop(1, '#0f0f15');
    this.ctx.fillStyle = bgGradient;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Show disconnected overlay if websocket is disconnected
    if (this.isDisconnected) {
      // Use display dimensions (accounting for device pixel ratio)
      const rect = this.canvas.getBoundingClientRect();
      const displayWidth = rect.width || this.canvas.clientWidth || 1200;
      const displayHeight = rect.height || this.canvas.clientHeight || 800;
      
      // Account for device pixel ratio in canvas coordinates
      const dpr = window.devicePixelRatio || 1;
      const canvasDisplayWidth = this.canvas.width / dpr;
      const canvasDisplayHeight = this.canvas.height / dpr;
      
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      this.ctx.fillRect(0, 0, canvasDisplayWidth, canvasDisplayHeight);
      
      this.ctx.fillStyle = '#ff6b6b';
      this.ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText('Disconnected', canvasDisplayWidth / 2, canvasDisplayHeight / 2 - 20);
      
      this.ctx.fillStyle = 'rgba(200, 200, 220, 0.8)';
      this.ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      this.ctx.fillText('Reconnecting...', canvasDisplayWidth / 2, canvasDisplayHeight / 2 + 20);
      
      // Don't render map/agent when disconnected - freeze UI
      return;
    }

    // Update zone dwell time
    const currentState = this.stateMachine.getState();
    const dwellTime = this.stateMachine.getDwellTime();
    if (currentState) {
      this.mapRenderer.setZoneDwellTime(`zone:${currentState}`, dwellTime);
    }

    // Render map
    this.mapRenderer.render();

    // Render agent
    this.agentController.render();

        // Update timeline
        this.timeline.render();
  }

  private startRenderLoop() {
    const loop = () => {
      // Update idle time periodically
      const now = Date.now();
      if (now - this.lastUpdateTime > 1000) {
        this.updateStatusPanel();
        this.lastUpdateTime = now;
      }
      
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new App());
} else {
  new App();
}
