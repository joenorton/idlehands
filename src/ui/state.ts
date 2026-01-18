import type { Event, FileTouchEvent, ToolCallEvent, AgentStateEvent } from '../model/events.js';

export type AgentState = 'reading' | 'writing' | 'executing' | 'thinking' | 'responding';

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
      if (ft.kind === 'read') {
        newState = 'reading';
      } else if (ft.kind === 'write') {
        newState = 'writing';
      }
    } else if (event.type === 'tool_call') {
      const tc = event as ToolCallEvent;
      if (tc.phase === 'start') {
        // All tool calls transition to executing state
        newState = 'executing';
      } else if (tc.phase === 'end') {
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
