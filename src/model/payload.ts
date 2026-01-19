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
  // Check hook_event_name for tool-related events (MOST RELIABLE)
  const hookEvent = payload.hook_event_name;
  if (hookEvent === 'beforeShellExecution' || hookEvent === 'afterShellExecution') return 'terminal';
  if (hookEvent === 'beforeMCPExecution' || hookEvent === 'afterMCPExecution') return 'mcp';
  
  // Check for explicit tool fields (RELIABLE)
  if (typeof payload.tool === 'string') return payload.tool;
  if (typeof payload.toolName === 'string') return payload.toolName;
  if (typeof payload.tool_name === 'string') return payload.tool_name;
  
  // Check for MCP-specific fields (RELIABLE)
  if (payload.mcp_server || payload.mcp_tool) return 'mcp';
  
  // Check for tool calls in structured format (RELIABLE)
  if (Array.isArray(payload.tool_calls)) {
    const firstCall = payload.tool_calls[0];
    if (firstCall && typeof firstCall.tool === 'string') {
      return firstCall.tool;
    }
  }
  
  // Check command field - ONLY for actual shell execution hooks
  // This prevents false positives from file paths or content that mentions these words
  if (hookEvent === 'beforeShellExecution' || hookEvent === 'afterShellExecution') {
    if (typeof payload.command === 'string') {
      const cmd = payload.command.toLowerCase().trim();
      // More specific checks for internet tools (actual HTTP requests)
      if (cmd.startsWith('curl ') || cmd.startsWith('wget ') || 
          cmd.match(/^(curl|wget)\s+https?:\/\//)) {
        return 'internet';
      }
      // More specific checks for test runners (actual test commands)
      if (cmd.match(/^(npm|yarn|pnpm)\s+(test|run\s+test)/) ||
          cmd.match(/^(jest|mocha|vitest|ava)\s/) ||
          cmd.startsWith('test ') || cmd.startsWith('npm test')) {
        return 'tests';
      }
      // Terminal commands (package managers, etc.)
      if (cmd.match(/^(npm|yarn|pnpm|pip|pip3|python|node)\s/)) {
        return 'terminal';
      }
    }
  }
  
  // REMOVED: Content/text-based tool detection
  // This was causing false positives - any mention of "internet", "test", etc. in agent
  // responses or file content would trigger tool detection, crowding out legitimate
  // READ/WRITE file_touch events. Only detect tools from explicit tool fields,
  // hook event names, or structured tool_calls arrays.
  
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
  
  // PRIORITY 1: Check for tool_calls array (structured tool call format)
  if (Array.isArray(payload.tool_calls) && payload.tool_calls.length > 0) {
    const firstCall = payload.tool_calls[0];
    if (firstCall && typeof firstCall === 'object') {
      // Check for args in the tool call
      if (firstCall.args && typeof firstCall.args === 'object') {
        const args = firstCall.args;
        if (args.url) {
          try {
            const url = new URL(args.url);
            const fullUrl = url.hostname + url.pathname + (url.search ? url.search : '');
            return fullUrl.length > 80 ? `${url.hostname}${url.pathname}` : fullUrl;
          } catch {
            return args.url;
          }
        }
        if (args.query) return `query: ${args.query}`;
        if (args.search) return `search: ${args.search}`;
        if (args.search_term) return `search: ${args.search_term}`;
        if (args.query_term) return `query: ${args.query_term}`;
        if (args.input && typeof args.input === 'string') {
          // input might contain the search query
          if (args.input.length < 100) return `query: ${args.input}`;
        }
      }
      // Check for input field directly on tool call
      if (firstCall.input && typeof firstCall.input === 'string' && firstCall.input.length < 100) {
        return `query: ${firstCall.input}`;
      }
    }
  }
  
  // PRIORITY 2: Check for tool-specific fields (most reliable)
  if (payload.tool_args && typeof payload.tool_args === 'object') {
    const args = payload.tool_args;
    if (args.url) {
      try {
        const url = new URL(args.url);
        const fullUrl = url.hostname + url.pathname + (url.search ? url.search : '');
        return fullUrl.length > 80 ? `${url.hostname}${url.pathname}` : fullUrl;
      } catch {
        return args.url;
      }
    }
    if (args.query) return `query: ${args.query}`;
    if (args.search) return `search: ${args.search}`;
    if (args.search_term) return `search: ${args.search_term}`;
    if (args.query_term) return `query: ${args.query_term}`;
    if (args.input && typeof args.input === 'string' && args.input.length < 100) {
      return `query: ${args.input}`;
    }
  }
  
  // PRIORITY 3: Check for explicit URL/query/search fields at top level
  if (typeof payload.url === 'string' && payload.url.trim()) {
    try {
      const url = new URL(payload.url);
      const fullUrl = url.hostname + url.pathname + (url.search ? url.search : '');
      return fullUrl.length > 80 ? `${url.hostname}${url.pathname}` : fullUrl;
    } catch {
      return payload.url.trim();
    }
  }
  
  if (typeof payload.query === 'string' && payload.query.trim()) {
    return `query: ${payload.query.trim()}`;
  }
  if (typeof payload.search === 'string' && payload.search.trim()) {
    return `search: ${payload.search.trim()}`;
  }
  if (typeof payload.search_term === 'string' && payload.search_term.trim()) {
    return `search: ${payload.search_term.trim()}`;
  }
  if (typeof payload.query_term === 'string' && payload.query_term.trim()) {
    return `query: ${payload.query_term.trim()}`;
  }
  
  // Also check for common alternative field names
  if (typeof payload.input === 'string' && payload.input.trim() && payload.input.length < 200) {
    // Only use input if it looks like a query (not code)
    if (!payload.input.match(/(?:function|const|let|var|class|interface|type|export|import|return|if|else|for|while|async|await|=>|{|}|\(|\)|;)/)) {
      return `query: ${payload.input.trim()}`;
    }
  }
  if (typeof payload.prompt === 'string' && payload.prompt.trim() && payload.prompt.length < 200) {
    if (!payload.prompt.match(/(?:function|const|let|var|class|interface|type|export|import|return|if|else|for|while|async|await|=>|{|}|\(|\)|;)/)) {
      return `query: ${payload.prompt.trim()}`;
    }
  }
  
  // PRIORITY 4: Check for request/endpoint fields
  if (typeof payload.request === 'string' && payload.request.trim()) {
    return payload.request.trim();
  }
  if (typeof payload.endpoint === 'string' && payload.endpoint.trim()) {
    return payload.endpoint.trim();
  }
  
  // PRIORITY 5: Check for method + URL combination
  if (typeof payload.method === 'string' && typeof payload.path === 'string') {
    return `${payload.method.toUpperCase()} ${payload.path}`;
  }
  
  // PRIORITY 6: Check command field for URLs (curl, wget, etc.)
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
    // Check for search query patterns in command
    const queryMatch = command.match(/(?:search|query|q)=([^\s&]+)/i);
    if (queryMatch) {
      return `query: ${decodeURIComponent(queryMatch[1])}`;
    }
    // If command contains internet-related terms and is short, show it
    if (command.length < 100) {
      return command;
    }
  }
  
  // PRIORITY 7: Check content/text for URLs or queries
  // BUT: Only skip if this is explicitly a file read hook (not just if file_path exists)
  // This allows internet tool calls that might have file_path from context to still extract queries
  const isFileReadHook = payload.hook_event_name === 'beforeReadFile' || 
                         payload.hookEventName === 'beforeReadFile';
  
  const contentSource = payload.content || payload.text;
  if (contentSource && !isFileReadHook) {
    const contentStr = typeof contentSource === 'string' ? contentSource : JSON.stringify(contentSource);
    
    // First, try to extract URLs (these are less likely to be false positives)
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
    
    // Then check for search terms, but be more careful
    // Look for patterns that look like actual search queries, not code
    // Only match if it's at the start of a line or after whitespace, and doesn't look like code
    
    // First, check if content looks like code (has imports, exports, function definitions, etc.)
    const looksLikeCode = contentStr.match(/(?:import|export|function|const|let|var|class|interface|type|return|if|else|for|while|=>|=>|async|await|\.ts|\.js|\.tsx|\.jsx)/);
    
    if (!looksLikeCode) {
      // Content doesn't look like code, so it's safer to extract queries
      // Look for search patterns
      const searchMatch = contentStr.match(/(?:^|\s)(?:search|query|lookup|find)[\s:]+([a-zA-Z0-9\s\-]{3,60})(?:\s|$|"|'|,|;|\)|\.)/im);
      if (searchMatch && searchMatch[1]) {
        const matchText = searchMatch[1].trim();
        // Additional check: don't match if it looks like code keywords
        if (matchText.length >= 3 && 
            !matchText.match(/(?:function|const|let|var|class|interface|type|export|import|return|if|else|for|while|async|await)/i) &&
            matchText.length < 80) { // Limit length to avoid matching large code blocks
          return `search: ${matchText}`;
        }
      }
      
      // Also try to extract if content is short and looks like a query (not code)
      // This handles cases where the query is just in the content without "search:" prefix
      if (contentStr.length < 200 && contentStr.length > 3) {
        // Check if it's a simple query-like string (no code patterns, reasonable length)
        const trimmed = contentStr.trim();
        if (!trimmed.match(/(?:function|const|let|var|class|interface|type|export|import|return|if|else|for|while|async|await|=>|{|}|\(|\)|;)/) &&
            trimmed.match(/^[a-zA-Z0-9\s\-\.]+$/) && // Only alphanumeric, spaces, hyphens, dots
            trimmed.split(/\s+/).length <= 10) { // Max 10 words
          return `query: ${trimmed}`;
        }
      }
    }
  }
  
  return undefined;
}

function extractMCPEvidence(payload: any): string | undefined {
  // Extract MCP server name - check multiple possible field names
  let server: string | undefined;
  if (typeof payload.mcp_server === 'string' && payload.mcp_server.trim()) {
    server = payload.mcp_server.trim();
  } else if (typeof payload.server === 'string' && payload.server.trim()) {
    server = payload.server.trim();
  } else if (typeof payload.server_name === 'string' && payload.server_name.trim()) {
    server = payload.server_name.trim();
  } else if (typeof payload.serverName === 'string' && payload.serverName.trim()) {
    server = payload.serverName.trim();
  } else if (typeof payload.mcpServer === 'string' && payload.mcpServer.trim()) {
    server = payload.mcpServer.trim();
  } else if (payload.mcp && typeof payload.mcp.server === 'string' && payload.mcp.server.trim()) {
    server = payload.mcp.server.trim();
  } else if (payload.context && typeof payload.context.server === 'string' && payload.context.server.trim()) {
    server = payload.context.server.trim();
  }
  
  // Extract MCP tool name - check multiple possible field names
  let tool: string | undefined;
  if (typeof payload.mcp_tool === 'string' && payload.mcp_tool.trim()) {
    tool = payload.mcp_tool.trim();
  } else if (typeof payload.tool === 'string' && payload.tool.trim()) {
    tool = payload.tool.trim();
  } else if (typeof payload.tool_name === 'string' && payload.tool_name.trim()) {
    tool = payload.tool_name.trim();
  } else if (typeof payload.toolName === 'string' && payload.toolName.trim()) {
    tool = payload.toolName.trim();
  } else if (typeof payload.name === 'string' && payload.name.trim()) {
    tool = payload.name.trim();
  } else if (typeof payload.mcpTool === 'string' && payload.mcpTool.trim()) {
    tool = payload.mcpTool.trim();
  } else if (payload.mcp && typeof payload.mcp.tool === 'string' && payload.mcp.tool.trim()) {
    tool = payload.mcp.tool.trim();
  } else if (payload.context && typeof payload.context.tool === 'string' && payload.context.tool.trim()) {
    tool = payload.context.tool.trim();
  }
  
  // Check if tool name contains server prefix (e.g., "mcp_idlehands-comfyui-mcp-server_list_models")
  // Parse format: "mcp_<server>_<tool>" or "<server>:<tool>"
  if (!server && tool) {
    const serverToolMatch = tool.match(/^mcp_([^_]+)_(.+)$/);
    if (serverToolMatch) {
      server = serverToolMatch[1];
      tool = serverToolMatch[2];
    } else {
      const colonMatch = tool.match(/^([^:]+):(.+)$/);
      if (colonMatch) {
        server = colonMatch[1];
        tool = colonMatch[2];
      }
    }
  }
  
  // Check for full tool identifier in other fields (e.g., "server:tool" format)
  if (!server || !tool) {
    const identifierFields = ['identifier', 'id', 'tool_id', 'toolId', 'toolIdentifier', 'name'];
    for (const field of identifierFields) {
      if (typeof payload[field] === 'string' && payload[field].includes(':')) {
        const parts = payload[field].split(':');
        if (parts.length === 2) {
          if (!server) server = parts[0].trim();
          if (!tool) tool = parts[1].trim();
          break;
        }
      }
    }
  }
  
  // Last resort: scan all payload keys for anything that looks like a server identifier
  // Also check nested objects recursively
  if (!server && typeof payload === 'object' && payload !== null) {
    const checkObject = (obj: any, depth = 0): void => {
      if (depth > 3) return; // Limit recursion depth
      if (typeof obj !== 'object' || obj === null) return;
      
      for (const key of Object.keys(obj)) {
        const keyLower = key.toLowerCase();
        const value = obj[key];
        
        // Check if this key/value looks like a server identifier
        if ((keyLower.includes('server') || keyLower.includes('mcp')) && 
            typeof value === 'string' && 
            value.trim() &&
            !keyLower.includes('tool')) {
          const candidate = value.trim();
          // Skip if it looks like a tool name (common tool patterns)
          if (!candidate.match(/^(generate|list|get|set|create|delete|update|read|write|fetch|call|invoke|mcp_)/i) &&
              candidate.length > 3 && // Server names are usually longer
              !candidate.includes('_') && // Tool names often have underscores
              candidate.includes('-')) { // Server names often have hyphens (e.g., "comfyui-mcp-server")
            server = candidate;
            return;
          }
        }
        
        // Recursively check nested objects
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          checkObject(value, depth + 1);
          if (server) return;
        }
      }
    };
    
    checkObject(payload);
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
  
  // Format: "server:tool (args)" or "server:tool" or "tool (args)" or just "tool"
  if (server && tool) {
    return argsStr ? `${server}:${tool} (${argsStr})` : `${server}:${tool}`;
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
  
  // PRIORITY: Check for tool_call events FIRST (especially MCP/terminal/internet)
  // This ensures tool executions are always classified as 'executing', not 'read' or 'write'
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
  
  // Only extract file_touch events if it's NOT a tool execution
  // This prevents MCP tools with file paths from being misclassified as file reads
  const path = extractPath(payload);
  if (path) {
    // CRITICAL: Double-check for tool execution hooks - NEVER create file_touch for tool executions
    // This handles cases where extractTool might have missed the tool, or where the payload
    // structure is different. Tool executions should ALWAYS be tool_call events, never file_touch.
    if (hookEvent === 'beforeMCPExecution' || hookEvent === 'afterMCPExecution' ||
        hookEvent === 'beforeShellExecution' || hookEvent === 'afterShellExecution') {
      // Force create a tool_call event instead of file_touch
      // This ensures tool executions are always classified as 'executing', not 'read' or 'write'
      const inferredTool = hookEvent.includes('MCP') ? 'mcp' : 'terminal';
      // Properly extract phase - 'after' hooks are 'end', 'before' hooks are 'start'
      const phase = hookEvent.startsWith('after') ? 'end' : 'start';
      const command = hookEvent.includes('MCP') ? extractMCPEvidence(payload) : extractCommand(payload);
      return createEvent('tool_call', sessionId, {
        tool: inferredTool,
        phase,
        command,
      }) as ToolCallEvent;
    }
    
    // Also check for MCP-specific fields as a fallback (in case hook_event_name is missing)
    if (payload.mcp_server || payload.mcp_tool || payload.mcpServer || payload.mcpTool) {
      // This looks like an MCP tool execution - create tool_call, not file_touch
      const phase = extractPhase(payload) || 'start';
      const command = extractMCPEvidence(payload);
      return createEvent('tool_call', sessionId, {
        tool: 'mcp',
        phase,
        command,
      }) as ToolCallEvent;
    }
    
    const kind = extractKind(payload) || 'write';
    const normalizedPath = repoRoot ? normalizePath(path, repoRoot) : path;
    return createEvent('file_touch', sessionId, {
      path: normalizedPath,
      kind,
    }) as FileTouchEvent;
  }

  // For agent response/thought events, try to extract file activity or tool usage
  // afterAgentThought represents agent processing/thinking - we only get the "after" event,
  // so we can't track a full thinking state. Instead, we only create events if there's
  // observable activity (file touches or tool calls), not for thinking itself.
  if (hookEvent === 'afterAgentResponse' || hookEvent === 'afterAgentThought') {
    // PRIORITY: Check for tool usage first (tools should always be 'executing', not 'read')
    // Re-extract tool to catch any tools that might have been missed
    const inferredTool = extractTool(payload);
    if (inferredTool) {
      const phase = hookEvent === 'afterAgentResponse' ? 'end' : 'start';
      const toolLower = inferredTool.toLowerCase();
      
      // Extract evidence based on tool type
      let command: string | undefined;
      if (toolLower === 'terminal' || toolLower.includes('terminal') || toolLower.includes('shell')) {
        command = extractCommand(payload);
      } else if (toolLower === 'internet' || toolLower.includes('internet') || toolLower.includes('web') || toolLower.includes('browser')) {
        command = extractInternetEvidence(payload);
      } else if (toolLower === 'mcp') {
        command = extractMCPEvidence(payload);
      } else {
        const toolName = sanitizeTool(inferredTool);
        const args = extractToolArgs(payload);
        command = args ? `${toolName} ${args}` : toolName;
      }
      
      return createEvent('tool_call', sessionId, {
        tool: sanitizeTool(inferredTool),
        phase,
        command,
      }) as ToolCallEvent;
    }
    
    // Only check for file activity if it's NOT a tool execution
    if (path) {
      const kind = extractKind(payload) || 'write';
      const normalizedPath = repoRoot ? normalizePath(path, repoRoot) : path;
      return createEvent('file_touch', sessionId, {
        path: normalizedPath,
        kind,
      }) as FileTouchEvent;
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
