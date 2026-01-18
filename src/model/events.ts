export type EventType = 'session' | 'file_touch' | 'tool_call' | 'unknown' | 'agent_state';

export interface BaseEvent {
  v: number;
  ts: number;
  type: EventType;
  session_id: string;
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

export type Event = SessionEvent | FileTouchEvent | ToolCallEvent | UnknownEvent | AgentStateEvent;

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
