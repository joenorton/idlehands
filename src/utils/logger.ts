import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { serializeEvent, type Event } from '../model/events.js';

const IDLEHANDS_DIR = join(homedir(), '.idlehands');
const EVENTS_FILE = join(IDLEHANDS_DIR, 'events.ndjson');

export async function ensureIdlehandsDir(): Promise<void> {
  try {
    await mkdir(IDLEHANDS_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore
  }
}

export async function appendEvent(event: Event): Promise<void> {
  await ensureIdlehandsDir();
  const line = serializeEvent(event) + '\n';
  await appendFile(EVENTS_FILE, line, 'utf-8');
}

export function getEventsFilePath(): string {
  return EVENTS_FILE;
}
