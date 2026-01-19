import type { Event, FileTouchEvent, ToolCallEvent, SessionEvent, AgentStateEvent, UnknownEvent } from './events.js';

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// Constants for validation
const MAX_SESSION_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_COMMAND_LENGTH = 8192;
const MAX_REASON_LENGTH = 512;
const MAX_PAYLOAD_KEYS = 100;
const MAX_METADATA_SIZE = 10000; // Max size of metadata object when stringified
const MIN_TIMESTAMP = 0;
const MAX_FUTURE_TIMESTAMP_OFFSET = 60; // Allow 60 seconds in the future for clock skew

/**
 * Validates an event object with comprehensive checks
 */
export function validateEvent(event: any): ValidationResult {
  const errors: ValidationError[] = [];

  // Check if event is an object
  if (!event || typeof event !== 'object') {
    return {
      valid: false,
      errors: [{ field: 'event', message: 'Event must be an object' }],
    };
  }

  // Validate version
  if (event.v === undefined || event.v === null) {
    errors.push({ field: 'v', message: 'Version is required' });
  } else if (typeof event.v !== 'number' || event.v !== 1) {
    errors.push({ field: 'v', message: 'Version must be 1' });
  }

  // Validate timestamp
  if (event.ts === undefined || event.ts === null) {
    errors.push({ field: 'ts', message: 'Timestamp is required' });
  } else if (typeof event.ts !== 'number') {
    errors.push({ field: 'ts', message: 'Timestamp must be a number' });
  } else {
    const now = Date.now() / 1000;
    if (event.ts < MIN_TIMESTAMP) {
      errors.push({ field: 'ts', message: 'Timestamp cannot be negative' });
    } else if (event.ts > now + MAX_FUTURE_TIMESTAMP_OFFSET) {
      errors.push({ field: 'ts', message: `Timestamp cannot be more than ${MAX_FUTURE_TIMESTAMP_OFFSET} seconds in the future` });
    }
  }

  // Validate type
  const validTypes: string[] = ['session', 'file_touch', 'tool_call', 'unknown', 'agent_state'];
  if (!event.type) {
    errors.push({ field: 'type', message: 'Event type is required' });
  } else if (!validTypes.includes(event.type)) {
    errors.push({ field: 'type', message: `Event type must be one of: ${validTypes.join(', ')}` });
  }

  // Validate session_id
  if (!event.session_id) {
    errors.push({ field: 'session_id', message: 'Session ID is required' });
  } else if (typeof event.session_id !== 'string') {
    errors.push({ field: 'session_id', message: 'Session ID must be a string' });
  } else if (event.session_id.length > MAX_SESSION_ID_LENGTH) {
    errors.push({ field: 'session_id', message: `Session ID cannot exceed ${MAX_SESSION_ID_LENGTH} characters` });
  } else if (event.session_id.length === 0) {
    errors.push({ field: 'session_id', message: 'Session ID cannot be empty' });
  }

  // Type-specific validation
  if (event.type === 'file_touch') {
    const ft = event as FileTouchEvent;
    if (!ft.path) {
      errors.push({ field: 'path', message: 'File path is required for file_touch events' });
    } else if (typeof ft.path !== 'string') {
      errors.push({ field: 'path', message: 'File path must be a string' });
    } else if (ft.path.length > MAX_PATH_LENGTH) {
      errors.push({ field: 'path', message: `File path cannot exceed ${MAX_PATH_LENGTH} characters` });
    }
    if (ft.kind !== 'read' && ft.kind !== 'write') {
      errors.push({ field: 'kind', message: "File touch kind must be 'read' or 'write'" });
    }
  } else if (event.type === 'tool_call') {
    const tc = event as ToolCallEvent;
    if (!tc.tool) {
      errors.push({ field: 'tool', message: 'Tool name is required for tool_call events' });
    } else if (typeof tc.tool !== 'string') {
      errors.push({ field: 'tool', message: 'Tool name must be a string' });
    } else if (tc.tool.length > MAX_TOOL_NAME_LENGTH) {
      errors.push({ field: 'tool', message: `Tool name cannot exceed ${MAX_TOOL_NAME_LENGTH} characters` });
    }
    if (tc.phase !== 'start' && tc.phase !== 'end') {
      errors.push({ field: 'phase', message: "Tool call phase must be 'start' or 'end'" });
    }
    if (tc.command !== undefined && tc.command !== null) {
      if (typeof tc.command !== 'string') {
        errors.push({ field: 'command', message: 'Command must be a string' });
      } else if (tc.command.length > MAX_COMMAND_LENGTH) {
        errors.push({ field: 'command', message: `Command cannot exceed ${MAX_COMMAND_LENGTH} characters` });
      }
    }
  } else if (event.type === 'session') {
    const se = event as SessionEvent;
    const validStates = ['start', 'stop', 'interrupt', 'crash'];
    if (!se.state) {
      errors.push({ field: 'state', message: 'Session state is required for session events' });
    } else if (!validStates.includes(se.state)) {
      errors.push({ field: 'state', message: `Session state must be one of: ${validStates.join(', ')}` });
    }
    if (se.repo_root !== undefined && se.repo_root !== null) {
      if (typeof se.repo_root !== 'string') {
        errors.push({ field: 'repo_root', message: 'Repository root must be a string' });
      } else if (se.repo_root.length > MAX_PATH_LENGTH) {
        errors.push({ field: 'repo_root', message: `Repository root cannot exceed ${MAX_PATH_LENGTH} characters` });
      }
    }
  } else if (event.type === 'agent_state') {
    const as = event as AgentStateEvent;
    if (as.state !== 'thinking' && as.state !== 'responding') {
      errors.push({ field: 'state', message: "Agent state must be 'thinking' or 'responding'" });
    }
    if (as.metadata !== undefined && as.metadata !== null) {
      if (typeof as.metadata !== 'object' || Array.isArray(as.metadata)) {
        errors.push({ field: 'metadata', message: 'Metadata must be an object' });
      } else {
        try {
          const metadataStr = JSON.stringify(as.metadata);
          if (metadataStr.length > MAX_METADATA_SIZE) {
            errors.push({ field: 'metadata', message: `Metadata cannot exceed ${MAX_METADATA_SIZE} bytes when serialized` });
          }
        } catch (e) {
          errors.push({ field: 'metadata', message: 'Metadata must be JSON-serializable' });
        }
      }
    }
  } else if (event.type === 'unknown') {
    const unk = event as UnknownEvent;
    if (!Array.isArray(unk.payload_keys)) {
      errors.push({ field: 'payload_keys', message: 'Payload keys must be an array' });
    } else {
      if (unk.payload_keys.length > MAX_PAYLOAD_KEYS) {
        errors.push({ field: 'payload_keys', message: `Payload keys array cannot exceed ${MAX_PAYLOAD_KEYS} items` });
      }
      // Validate each key is a string
      for (let i = 0; i < unk.payload_keys.length; i++) {
        if (typeof unk.payload_keys[i] !== 'string') {
          errors.push({ field: `payload_keys[${i}]`, message: 'Each payload key must be a string' });
        }
      }
    }
    if (unk.reason !== undefined && unk.reason !== null) {
      if (typeof unk.reason !== 'string') {
        errors.push({ field: 'reason', message: 'Reason must be a string' });
      } else if (unk.reason.length > MAX_REASON_LENGTH) {
        errors.push({ field: 'reason', message: `Reason cannot exceed ${MAX_REASON_LENGTH} characters` });
      }
    }
    if (unk.hook_event_name !== undefined && unk.hook_event_name !== null) {
      if (typeof unk.hook_event_name !== 'string') {
        errors.push({ field: 'hook_event_name', message: 'Hook event name must be a string' });
      } else if (unk.hook_event_name.length > 256) {
        errors.push({ field: 'hook_event_name', message: 'Hook event name cannot exceed 256 characters' });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Type guard to check if an object is a valid Event after validation
 */
export function isValidEvent(event: any): event is Event {
  return validateEvent(event).valid;
}
