import { createEvent, type Event, type FileTouchEvent, type ToolCallEvent, type SessionEvent, type AgentStateEvent } from './events.js';
import { normalizePath } from '../utils/paths.js';

const KNOWN_TOOLS = ['internet', 'terminal', 'tests', 'docs'];

function sanitizeTool(tool: string): string {
  const lower = tool.toLowerCase();
  if (KNOWN_TOOLS.includes(lower)) {
    return lower;
  }
  return tool; // Keep unknown tools as-is for now
}

function extractPath(payload: any): string | null {
  // Cursor uses file_path (with underscore) - check this first
  if (typeof payload.file_path === 'string') {
    return payload.file_path;
  }
  
  // Try various candidate fields
  if (typeof payload.path === 'string') return payload.path;
  if (typeof payload.file === 'string') return payload.file;
  if (typeof payload.target === 'string') return payload.target;
  if (typeof payload.filePath === 'string') return payload.filePath;
  if (typeof payload.filepath === 'string') return payload.filepath;
  if (typeof payload.uri === 'string') {
    // Handle file:// URIs
    const uri = payload.uri;
    if (uri.startsWith('file://')) {
      return uri.replace('file://', '').replace(/^\/+/, '');
    }
    return uri;
  }
  
  // Try arrays of edits (Cursor uses edits array)
  if (Array.isArray(payload.edits) && payload.edits.length > 0) {
    const firstEdit = payload.edits[0];
    if (firstEdit) {
      // Cursor edit objects might have file_path or path
      if (typeof firstEdit.file_path === 'string') return firstEdit.file_path;
      if (typeof firstEdit.path === 'string') return firstEdit.path;
      if (typeof firstEdit.uri === 'string') {
        const uri = firstEdit.uri;
        if (uri.startsWith('file://')) {
          return uri.replace('file://', '').replace(/^\/+/, '');
        }
        return uri;
      }
    }
  }
  
  // Check attachments array (Cursor may use this for file references)
  if (Array.isArray(payload.attachments)) {
    for (const attachment of payload.attachments) {
      if (typeof attachment === 'string') {
        // Might be a file path
        if (attachment.includes('/') || attachment.includes('\\')) {
          return attachment;
        }
      } else if (attachment && typeof attachment.file_path === 'string') {
        return attachment.file_path;
      } else if (attachment && typeof attachment.path === 'string') {
        return attachment.path;
      } else if (attachment && typeof attachment.uri === 'string') {
        const uri = attachment.uri;
        if (uri.startsWith('file://')) {
          return uri.replace('file://', '').replace(/^\/+/, '');
        }
        return uri;
      }
    }
  }
  
  if (Array.isArray(payload.files)) {
    const firstFile = payload.files[0];
    if (firstFile && typeof firstFile === 'string') return firstFile;
    if (firstFile && typeof firstFile.file_path === 'string') return firstFile.file_path;
    if (firstFile && typeof firstFile.uri === 'string') {
      const uri = firstFile.uri;
      if (uri.startsWith('file://')) {
        return uri.replace('file://', '').replace(/^\/+/, '');
      }
      return uri;
    }
  }
  
  return null;
}

function extractTool(payload: any): string | null {
  // Check hook_event_name for tool-related events
  const hookEvent = payload.hook_event_name;
  if (hookEvent === 'beforeShellExecution' || hookEvent === 'afterShellExecution') return 'terminal';
  if (hookEvent === 'beforeMCPExecution' || hookEvent === 'afterMCPExecution') return 'mcp';
  
  // Check for explicit tool fields
  if (typeof payload.tool === 'string') return payload.tool;
  if (typeof payload.toolName === 'string') return payload.toolName;
  if (typeof payload.tool_name === 'string') return payload.tool_name;
  
  // Check for MCP-specific fields
  if (payload.mcp_server || payload.mcp_tool) return 'mcp';
  
  // Check command field - might indicate tool usage
  if (typeof payload.command === 'string') {
    const cmd = payload.command.toLowerCase();
    if (cmd.includes('curl') || cmd.includes('wget') || cmd.includes('http')) return 'internet';
    if (cmd.includes('test') || cmd.includes('jest') || cmd.includes('mocha')) return 'tests';
    if (cmd.includes('npm') || cmd.includes('yarn') || cmd.includes('pip')) return 'terminal';
  }
  
  // Check content/text for tool indicators (for agent response/thought events)
  const contentSource = payload.content || payload.text;
  if (contentSource) {
    const contentStr = typeof contentSource === 'string' ? contentSource : JSON.stringify(contentSource);
    const lowerContent = contentStr.toLowerCase();
    
    // Look for tool usage patterns
    if (lowerContent.includes('internet') || lowerContent.includes('web') || lowerContent.includes('fetch') || lowerContent.includes('api')) {
      return 'internet';
    }
    if (lowerContent.includes('test') || lowerContent.includes('spec') || lowerContent.includes('assert')) {
      return 'tests';
    }
    if (lowerContent.includes('terminal') || lowerContent.includes('shell') || lowerContent.includes('command')) {
      return 'terminal';
    }
    if (lowerContent.includes('doc') || lowerContent.includes('readme') || lowerContent.includes('documentation')) {
      return 'docs';
    }
  }
  
  // Check for tool calls in structured format
  if (Array.isArray(payload.tool_calls)) {
    const firstCall = payload.tool_calls[0];
    if (firstCall && typeof firstCall.tool === 'string') {
      return firstCall.tool;
    }
  }
  
  return null;
}

function extractKind(payload: any): 'read' | 'write' | null {
  // Check hook_event_name to determine read vs write
  const hookEvent = payload.hook_event_name;
  if (hookEvent === 'beforeReadFile') return 'read';
  if (hookEvent === 'afterFileEdit') return 'write';
  
  if (payload.kind === 'read' || payload.kind === 'write') return payload.kind;
  if (payload.action === 'read' || payload.action === 'write') return payload.action;
  if (payload.operation === 'read' || payload.operation === 'write') return payload.operation;
  // Default to write if we detect a file modification
  if (payload.type === 'write' || payload.type === 'edit' || payload.type === 'modify') {
    return 'write';
  }
  // If we have edits array, it's a write
  if (Array.isArray(payload.edits) && payload.edits.length > 0) {
    return 'write';
  }
  return null;
}

function extractPhase(payload: any): 'start' | 'end' | null {
  // Check hook_event_name for phase indication
  const hookEvent = payload.hook_event_name;
  if (hookEvent === 'beforeShellExecution' || hookEvent === 'beforeReadFile' || hookEvent === 'beforeMCPExecution') return 'start';
  if (hookEvent === 'afterShellExecution' || hookEvent === 'afterFileEdit' || hookEvent === 'afterMCPExecution') return 'end';
  
  if (payload.phase === 'start' || payload.phase === 'end') return payload.phase;
  if (payload.state === 'start' || payload.state === 'end') return payload.state;
  return null;
}

function extractCommand(payload: any): string | undefined {
  // Check for command field (shell execution hooks)
  if (typeof payload.command === 'string' && payload.command.trim()) {
    return payload.command.trim();
  }
  // Check for command_line or cmd fields
  if (typeof payload.command_line === 'string' && payload.command_line.trim()) {
    return payload.command_line.trim();
  }
  if (typeof payload.cmd === 'string' && payload.cmd.trim()) {
    return payload.cmd.trim();
  }
  // Check for command in shell execution context
  if (payload.shell && typeof payload.shell.command === 'string') {
    return payload.shell.command.trim();
  }
  return undefined;
}

function extractInternetEvidence(payload: any): string | undefined {
  // Try to extract URL, query, or search terms from internet tool calls
  // Check for explicit URL field
  if (typeof payload.url === 'string' && payload.url.trim()) {
    try {
      const url = new URL(payload.url);
      // Return full URL for more context (hostname + path + query if short)
      const fullUrl = url.hostname + url.pathname + (url.search ? url.search : '');
      return fullUrl.length > 80 ? `${url.hostname}${url.pathname}` : fullUrl;
    } catch {
      return payload.url.trim();
    }
  }
  
  // Check for query/search field
  if (typeof payload.query === 'string' && payload.query.trim()) {
    return `query: ${payload.query.trim()}`;
  }
  if (typeof payload.search === 'string' && payload.search.trim()) {
    return `search: ${payload.search.trim()}`;
  }
  
  // Check for request/endpoint fields
  if (typeof payload.request === 'string' && payload.request.trim()) {
    return payload.request.trim();
  }
  if (typeof payload.endpoint === 'string' && payload.endpoint.trim()) {
    return payload.endpoint.trim();
  }
  
  // Check for method + URL combination
  if (typeof payload.method === 'string' && typeof payload.path === 'string') {
    return `${payload.method.toUpperCase()} ${payload.path}`;
  }
  
  // Check command field for URLs (curl, wget, etc.)
  const command = extractCommand(payload);
  if (command) {
    // Try to extract URL from command
    const urlMatch = command.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      try {
        const url = new URL(urlMatch[0]);
        const fullUrl = url.hostname + url.pathname + (url.search ? url.search : '');
        return fullUrl.length > 80 ? `${url.hostname}${url.pathname}` : fullUrl;
      } catch {
        return urlMatch[0].substring(0, 80);
      }
    }
    // Check for search query patterns
    const queryMatch = command.match(/(?:search|query|q)=([^\s&]+)/i);
    if (queryMatch) {
      return `query: ${decodeURIComponent(queryMatch[1])}`;
    }
    // If command contains internet-related terms, show it
    if (command.length < 100) {
      return command;
    }
  }
  
  // Check content/text for URLs or queries
  const contentSource = payload.content || payload.text;
  if (contentSource) {
    const contentStr = typeof contentSource === 'string' ? contentSource : JSON.stringify(contentSource);
    const urlMatch = contentStr.match(/https?:\/\/[^\s"']+/);
    if (urlMatch) {
      try {
        const url = new URL(urlMatch[0]);
        const fullUrl = url.hostname + url.pathname + (url.search ? url.search : '');
        return fullUrl.length > 80 ? `${url.hostname}${url.pathname}` : fullUrl;
      } catch {
        return urlMatch[0].substring(0, 80);
      }
    }
    // Check for search terms in content
    const searchMatch = contentStr.match(/(?:search|query|lookup|find)[\s:]+([^\n"']{1,60})/i);
    if (searchMatch) {
      return `search: ${searchMatch[1].trim()}`;
    }
  }
  
  // Check for tool-specific fields
  if (payload.tool_args && typeof payload.tool_args === 'object') {
    const args = payload.tool_args;
    if (args.url) return args.url;
    if (args.query) return `query: ${args.query}`;
    if (args.search) return `search: ${args.search}`;
  }
  
  return undefined;
}

function extractMCPEvidence(payload: any): string | undefined {
  // Extract MCP server name
  let server: string | undefined;
  if (typeof payload.mcp_server === 'string' && payload.mcp_server.trim()) {
    server = payload.mcp_server.trim();
  } else if (typeof payload.server === 'string' && payload.server.trim()) {
    server = payload.server.trim();
  } else if (typeof payload.server_name === 'string' && payload.server_name.trim()) {
    server = payload.server_name.trim();
  }
  
  // Extract MCP tool name
  let tool: string | undefined;
  if (typeof payload.mcp_tool === 'string' && payload.mcp_tool.trim()) {
    tool = payload.mcp_tool.trim();
  } else if (typeof payload.tool === 'string' && payload.tool.trim()) {
    tool = payload.tool.trim();
  } else if (typeof payload.tool_name === 'string' && payload.tool_name.trim()) {
    tool = payload.tool_name.trim();
  } else if (typeof payload.name === 'string' && payload.name.trim()) {
    tool = payload.name.trim();
  }
  
  // Extract arguments/parameters
  let argsStr: string | undefined;
  if (payload.args) {
    if (typeof payload.args === 'string') {
      argsStr = payload.args.trim();
    } else if (typeof payload.args === 'object') {
      const entries = Object.entries(payload.args);
      if (entries.length > 0) {
        argsStr = entries.map(([k, v]) => {
          const val = typeof v === 'string' ? v : JSON.stringify(v);
          return val.length > 30 ? val.substring(0, 30) + '...' : val;
        }).join(', ');
      }
    }
  } else if (payload.arguments && typeof payload.arguments === 'object') {
    const entries = Object.entries(payload.arguments);
    if (entries.length > 0) {
      argsStr = entries.map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        return val.length > 30 ? val.substring(0, 30) + '...' : val;
      }).join(', ');
    }
  } else if (payload.params && typeof payload.params === 'object') {
    const entries = Object.entries(payload.params);
    if (entries.length > 0) {
      argsStr = entries.map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        return val.length > 30 ? val.substring(0, 30) + '...' : val;
      }).join(', ');
    }
  } else if (payload.input) {
    if (typeof payload.input === 'string') {
      argsStr = payload.input.length > 60 ? payload.input.substring(0, 60) + '...' : payload.input;
    } else if (typeof payload.input === 'object') {
      argsStr = JSON.stringify(payload.input);
      if (argsStr.length > 60) {
        argsStr = argsStr.substring(0, 60) + '...';
      }
    }
  }
  
  // Format: "server/tool (args)" or "server/tool" or "tool (args)" or just "tool"
  if (server && tool) {
    return argsStr ? `${server}/${tool} (${argsStr})` : `${server}/${tool}`;
  } else if (tool) {
    return argsStr ? `${tool} (${argsStr})` : tool;
  } else if (server) {
    return argsStr ? `${server} (${argsStr})` : server;
  }
  
  // Fallback: try to extract from other fields
  if (argsStr) {
    return argsStr;
  }
  
  return undefined;
}

function extractToolArgs(payload: any): string | undefined {
  // Extract arguments for tool calls (for tools panel)
  // Check for args, arguments, params, parameters fields
  if (payload.args) {
    if (typeof payload.args === 'string') {
      return payload.args;
    }
    if (typeof payload.args === 'object') {
      // Try to format as key=value pairs or just values
      const entries = Object.entries(payload.args);
      if (entries.length > 0) {
        return entries.map(([k, v]) => {
          const val = typeof v === 'string' ? v : JSON.stringify(v);
          return val.length > 20 ? val.substring(0, 20) + '...' : val;
        }).join(', ');
      }
    }
  }
  
  // Check for parameters
  if (payload.parameters && typeof payload.parameters === 'object') {
    const entries = Object.entries(payload.parameters);
    if (entries.length > 0) {
      return entries.map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        return val.length > 20 ? val.substring(0, 20) + '...' : val;
      }).join(', ');
    }
  }
  
  // Check for input field (common in MCP tools)
  if (payload.input) {
    if (typeof payload.input === 'string') {
      return payload.input.length > 40 ? payload.input.substring(0, 40) + '...' : payload.input;
    }
    if (typeof payload.input === 'object') {
      return JSON.stringify(payload.input).substring(0, 40) + '...';
    }
  }
  
  return undefined;
}

function redactPayload(payload: any): string[] {
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }
  return Object.keys(payload);
}

export function extractEventFromPayload(
  payload: any,
  sessionId: string,
  repoRoot?: string
): Event {
  const hookEvent = payload.hook_event_name;
  
  // Handle session stop events
  if (hookEvent === 'stop') {
    return createEvent('session', sessionId, {
      state: 'stop',
      repo_root: repoRoot,
    }) as SessionEvent;
  }
  
  // Try to extract file_touch event
  const path = extractPath(payload);
  if (path) {
    const kind = extractKind(payload) || 'write';
    const normalizedPath = repoRoot ? normalizePath(path, repoRoot) : path;
    return createEvent('file_touch', sessionId, {
      path: normalizedPath,
      kind,
    }) as FileTouchEvent;
  }

  // Try to extract tool_call event
  const tool = extractTool(payload);
  if (tool) {
    const phase = extractPhase(payload) || 'start';
    const toolLower = tool.toLowerCase();
    
    // Extract evidence based on tool type
    let command: string | undefined;
    if (toolLower === 'terminal' || toolLower.includes('terminal') || toolLower.includes('shell')) {
      // Terminal: extract command
      command = extractCommand(payload);
    } else if (toolLower === 'internet' || toolLower.includes('internet') || toolLower.includes('web') || toolLower.includes('browser')) {
      // Internet: extract URL/query evidence
      command = extractInternetEvidence(payload);
    } else if (toolLower === 'mcp') {
      // MCP: extract server/tool/args evidence
      command = extractMCPEvidence(payload);
    } else {
      // Other tools: extract tool name and args
      const toolName = sanitizeTool(tool);
      const args = extractToolArgs(payload);
      command = args ? `${toolName} ${args}` : toolName;
    }
    
    return createEvent('tool_call', sessionId, {
      tool: sanitizeTool(tool),
      phase,
      command,
    }) as ToolCallEvent;
  }

  // For agent response/thought events, try to extract file activity or tool usage
  // afterAgentThought represents agent processing/thinking - we only get the "after" event,
  // so we can't track a full thinking state. Instead, we only create events if there's
  // observable activity (file touches or tool calls), not for thinking itself.
  if (hookEvent === 'afterAgentResponse' || hookEvent === 'afterAgentThought') {
    // Check if there's any file activity in the response
    if (path) {
      const kind = extractKind(payload) || 'write';
      const normalizedPath = repoRoot ? normalizePath(path, repoRoot) : path;
      return createEvent('file_touch', sessionId, {
        path: normalizedPath,
        kind,
      }) as FileTouchEvent;
    }
    
    // If we have content/text, try to infer tool from it
    if (payload.content || payload.text) {
      // Re-extract tool now that we've updated extractTool to check text field
      const inferredTool = extractTool(payload);
      if (inferredTool) {
        return createEvent('tool_call', sessionId, {
          tool: sanitizeTool(inferredTool),
          phase: hookEvent === 'afterAgentResponse' ? 'end' : 'start',
        }) as ToolCallEvent;
      }
    }
    
    // For afterAgentThought without observable activity: create agent_state event
    if (hookEvent === 'afterAgentThought') {
      const metadata: Record<string, any> = {};
      if (payload.duration_ms !== undefined) metadata.duration_ms = payload.duration_ms;
      if (payload.model) metadata.model = payload.model;
      if (payload.generation_id) metadata.generation_id = payload.generation_id;
      
      return createEvent('agent_state', sessionId, {
        state: 'thinking',
        metadata,
      }) as AgentStateEvent;
    }
    
    // For afterAgentResponse without observable activity: create agent_state event
    if (hookEvent === 'afterAgentResponse') {
      const metadata: Record<string, any> = {};
      if (payload.duration_ms !== undefined) metadata.duration_ms = payload.duration_ms;
      if (payload.model) metadata.model = payload.model;
      if (payload.generation_id) metadata.generation_id = payload.generation_id;
      if (payload.text && typeof payload.text === 'string') {
        // Include first 50 chars of text for context
        metadata.text_preview = payload.text.substring(0, 50) + (payload.text.length > 50 ? '...' : '');
      }
      
      return createEvent('agent_state', sessionId, {
        state: 'responding',
        metadata,
      }) as AgentStateEvent;
    }
  }

  // Fallback to unknown event with redacted keys only
  const metadata: Record<string, any> = {};
  if (payload.model) metadata.model = payload.model;
  if (payload.duration_ms !== undefined) metadata.duration_ms = payload.duration_ms;
  
  return createEvent('unknown', sessionId, {
    payload_keys: redactPayload(payload),
    hook_event_name: hookEvent,
    reason: `Could not extract file_touch or tool_call from payload (hook: ${hookEvent || 'unknown'})`,
    metadata,
  });
}
