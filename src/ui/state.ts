import type { Event, FileTouchEvent, ToolCallEvent, AgentStateEvent } from '../model/events.js';

export type AgentState = 'reading' | 'writing' | 'executing';

export interface StateTransition {
  from: AgentState;
  to: AgentState;
  timestamp: number;
}

export class AgentStateMachine {
  private currentState: AgentState | null = null; // Start with no state
  private stateStartTime: number = Date.now();
  private previousNonExecutingState: AgentState | null = null;
  private onStateChange?: (transition: StateTransition) => void;
  private lastToolCallEndTime: number = 0; // Track when tool calls end
  private toolCallResultWindow = 2000; // Ignore file_touch events within 2s of tool call end

  constructor(onStateChange?: (transition: StateTransition) => void) {
    this.onStateChange = onStateChange;
  }

  getState(): AgentState | null {
    return this.currentState;
  }

  getStateStartTime(): number {
    return this.stateStartTime;
  }

  getDwellTime(): number {
    return (Date.now() - this.stateStartTime) / 1000; // seconds
  }

  processEvent(event: Event): boolean {
    // Returns true if state changed
    // Note: agent_state events (thinking/responding) are ephemeral beacons only,
    // they don't cause state transitions
    let newState: AgentState | null = null;

    if (event.type === 'file_touch') {
      const ft = event as FileTouchEvent;
      
      // Ignore file_touch WRITE events that occur during or immediately after tool executions
      // These are likely results of tool calls (e.g., generated files) and shouldn't
      // override the tool execution state. Read events are still processed normally.
      const timeSinceToolCallEnd = Date.now() - this.lastToolCallEndTime;
      const isInToolResultWindow = timeSinceToolCallEnd < this.toolCallResultWindow;
      const isCurrentlyExecuting = this.currentState === 'executing';
      const isWriteEvent = ft.kind === 'write';
      
      // Don't transition from 'executing' to 'writing' if we're in the tool result window
      // This prevents tool-generated files from overriding the tool execution state
      // But still allow reads to transition (they might be legitimate file reads)
      if (ft.kind === 'read') {
        newState = 'reading';
      } else if (ft.kind === 'write') {
        // Only ignore write events if we're executing and in the tool result window
        if (!(isCurrentlyExecuting && isInToolResultWindow)) {
          newState = 'writing';
        }
        // Otherwise, ignore this write event (it's likely a tool result)
      }
    } else if (event.type === 'tool_call') {
      const tc = event as ToolCallEvent;
      if (tc.phase === 'start') {
        // All tool calls transition to executing state
        newState = 'executing';
      } else if (tc.phase === 'end') {
        // Track when tool call ends
        this.lastToolCallEndTime = Date.now();
        // Return to previous non-executing state
        newState = this.previousNonExecutingState;
      }
    }
    // agent_state events (thinking/responding) are handled as ephemeral beacons only
    // They don't cause state transitions

    if (newState !== null && newState !== this.currentState) {
      this.transitionTo(newState);
      return true;
    }

    return false;
  }

  private transitionTo(newState: AgentState) {
    const from = this.currentState;
    const to = newState;

    // Track previous non-executing state (only activity states, not agent states)
    if (this.currentState !== null &&
        this.currentState !== 'executing') {
      this.previousNonExecutingState = this.currentState;
    }

    this.currentState = to;
    this.stateStartTime = Date.now();

    if (this.onStateChange) {
      // Provide a default 'from' state if null
      const fromState: AgentState = from || 'reading';
      this.onStateChange({ from: fromState, to, timestamp: Date.now() });
    }
  }

  destroy() {
    // No cleanup needed
  }
}
