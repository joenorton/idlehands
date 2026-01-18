#!/usr/bin/env node

import { createServer } from 'http';
import { parse } from 'url';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, statSync, existsSync } from 'fs';
import { setupRoutes } from './routes.js';
import { setupWebSocket } from './websocket.js';
import { startFileWatcher } from './fileWatcher.js';
import { computeLayout, type Layout } from './layout.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ServerConfig {
  repo: string;
  maxFiles: number;
  maxDepth: number;
  ignore: string[];
  port: number;
}

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2);
  const config: ServerConfig = {
    repo: process.cwd(),
    maxFiles: 2000,
    maxDepth: 3,
    ignore: [],
    port: 8765,
  };

  // Check for IDLEHANDS_PORT environment variable first
  if (process.env.IDLEHANDS_PORT) {
    const envPort = parseInt(process.env.IDLEHANDS_PORT, 10);
    if (!isNaN(envPort) && envPort > 0 && envPort <= 65535) {
      config.port = envPort;
    }
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) {
      config.repo = args[i + 1];
      i++;
    } else if (args[i] === '--max-files' && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        config.maxFiles = parsed;
      }
      i++;
    } else if (args[i] === '--max-depth' && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        config.maxDepth = parsed;
      }
      i++;
    } else if (args[i] === '--ignore' && args[i + 1]) {
      config.ignore.push(args[i + 1]);
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
        config.port = parsed;
      }
      i++;
    }
  }

  return config;
}

function getMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    'html': 'text/html',
    'js': 'application/javascript',
    'css': 'text/css',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
  };
  return mimeTypes[ext || ''] || 'application/octet-stream';
}

function serveStatic(req: any, res: any, uiDir: string) {
  const parsedUrl = parse(req.url || '/', true);
  let pathname = parsedUrl.pathname || '/';
  
  if (pathname === '/') {
    pathname = '/index.html';
  }

  const filePath = resolve(join(uiDir, pathname));
  const resolvedUiDir = resolve(uiDir);
  
  // Security: Prevent path traversal attacks
  if (!filePath.startsWith(resolvedUiDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  
  try {
    const stats = statSync(filePath);
    if (stats.isFile()) {
      const content = readFileSync(filePath);
      const mimeType = getMimeType(filePath);
      res.writeHead(200, { 'Content-Type': mimeType });
      res.end(content);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

async function main() {
  const config = parseArgs();
  
  console.log(`Starting Idlehands server`);
  console.log(`  Repo: ${config.repo}`);
  console.log(`  Port: ${config.port}`);
  console.log(`  Max files: ${config.maxFiles}`);
  console.log(`  Max depth: ${config.maxDepth}`);

  // Compute layout once
  console.log('Computing layout...');
  const layout = await computeLayout(config.repo, config.maxFiles, config.maxDepth, config.ignore);
  console.log(`  Found ${layout.nodes.length} nodes, ${layout.zones.length} zones`);

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url || '/', true);
    const pathname = parsedUrl.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // API routes
    if (pathname?.startsWith('/api/')) {
      setupRoutes(req, res, layout);
      return;
    }

    // Static files - try dist/ui first (production), then src/ui (development)
    let uiDir = join(__dirname, '..', 'ui');
    if (!existsSync(uiDir)) {
      uiDir = join(process.cwd(), 'src', 'ui');
    }
    serveStatic(req, res, uiDir);
  });

  // Setup WebSocket
  setupWebSocket(server);
  console.log('WebSocket server initialized at /ws');

  // Start file watcher
  startFileWatcher();
  console.log('File watcher started');

  server.listen(config.port, () => {
    console.log(`\n🚀 Server running at http://localhost:${config.port}`);
    console.log('📊 Open this URL in your browser to view the visualization');
    console.log('👀 Watching for events...\n');
  }).on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${config.port} is already in use.`);
      console.error(`   Try a different port: --port <number> or IDLEHANDS_PORT=<number>`);
    } else {
      console.error(`\n❌ Server error:`, error);
    }
    process.exit(1);
  });
}

main().catch(console.error);
