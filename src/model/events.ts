export type EventType = 'session' | 'file_touch' | 'tool_call' | 'unknown' | 'agent_state' | 'run' | 'thrash';

export interface BaseEvent {
  v: number;
  ts: number;
  type: EventType;
  session_id: string;
  id?: string; // Canonical event ID: "source:lineStartOffset"
}

export interface SessionEvent extends BaseEvent {
  type: 'session';
  state: 'start' | 'stop' | 'interrupt' | 'crash';
  repo_root?: string;
}

export interface FileTouchEvent extends BaseEvent {
  type: 'file_touch';
  path: string;
  kind: 'read' | 'write';
}

export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  tool: string;
  phase: 'start' | 'end';
  command?: string; // Optional command string for terminal/shell executions
}

export interface UnknownEvent extends BaseEvent {
  type: 'unknown';
  payload_keys: string[];
  reason?: string;
  hook_event_name?: string;
  metadata?: Record<string, any>; // Key metadata fields for identification
}

export interface AgentStateEvent extends BaseEvent {
  type: 'agent_state';
  state: 'thinking' | 'responding';
  metadata?: Record<string, any>; // Optional metadata (model, duration, etc.)
}

export interface RunEvent extends BaseEvent {
  type: 'run';
  phase: 'start' | 'end';
  run_id: string;
  inferred: boolean;
  reason: 'after_end_marker' | 'gap' | 'end_marker';
}

export interface ThrashStartEvent extends BaseEvent {
  type: 'thrash';
  phase: 'start';
  run_id: string;
  signature: 'internet_only' | 'internet_test_loop' | 'test_only' | 'switch_frenzy';
}

export interface ThrashEndEvent extends BaseEvent {
  type: 'thrash';
  phase: 'end';
  run_id: string;
  signature: 'internet_only' | 'internet_test_loop' | 'test_only' | 'switch_frenzy';
  evidence: {
    duration: number;
    researchCalls: number;
    testRestarts: number;
    writes: number;
    writesCode: number;
    longestNoProgressGap: number;
    switchRate: number;
    confidence: 'low' | 'medium' | 'high';
  };
}

export type Event = SessionEvent | FileTouchEvent | ToolCallEvent | UnknownEvent | AgentStateEvent | RunEvent | ThrashStartEvent | ThrashEndEvent;

export function createEvent(
  type: EventType,
  sessionId: string,
  data: Partial<Event>
): Event {
  const base: BaseEvent = {
    v: 1,
    ts: Date.now() / 1000,
    type,
    session_id: sessionId,
  };

  switch (type) {
    case 'session':
      return { ...base, ...data, type: 'session' } as SessionEvent;
    case 'file_touch':
      return { ...base, ...data, type: 'file_touch' } as FileTouchEvent;
    case 'tool_call':
      return { ...base, ...data, type: 'tool_call' } as ToolCallEvent;
    case 'unknown':
      return { ...base, ...data, type: 'unknown' } as UnknownEvent;
    case 'agent_state':
      return { ...base, ...data, type: 'agent_state' } as AgentStateEvent;
    case 'run':
      return { ...base, ...data, type: 'run' } as RunEvent;
    case 'thrash':
      return { ...base, ...data, type: 'thrash' } as ThrashStartEvent | ThrashEndEvent;
  }
}

export function serializeEvent(event: Event): string {
  return JSON.stringify(event);
}

export function parseEvent(line: string): Event | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed.v === 1 && parsed.type && parsed.ts && parsed.session_id) {
      return parsed as Event;
    }
    return null;
  } catch {
    return null;
  }
}
