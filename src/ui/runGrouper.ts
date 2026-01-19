import type { Event, SessionEvent, RunEvent } from '../model/events.js';

const INACTIVITY_GAP_MS = 30000; // 30 seconds

export class RunGrouper {
  private currentRunId: string | null = null;
  private lastEventTime: number = 0;
  private runCounter = 0;

  processEvent(event: Event): Event[] {
    const now = event.ts * 1000; // Convert to milliseconds
    const results: Event[] = [];

    // Check for explicit end marker (session stop)
    if (event.type === 'session') {
      const se = event as SessionEvent;
      if (se.state === 'stop') {
        // Ignore redundant stops when no run active
        if (this.currentRunId !== null) {
          // Emit run.end for explicit end marker
          const runEnd: RunEvent = {
            v: 1,
            ts: event.ts,
            type: 'run',
            session_id: event.session_id,
            phase: 'end',
            run_id: this.currentRunId,
            inferred: false,
            reason: 'end_marker',
          };
          results.push(runEnd);
          this.currentRunId = null;
        }
        // Return the original stop event
        results.push(event);
        this.lastEventTime = now;
        return results;
      }
    }

    // Check for inactivity gap (soft boundary)
    if (this.currentRunId !== null && this.lastEventTime > 0) {
      const gap = now - this.lastEventTime;
      if (gap >= INACTIVITY_GAP_MS) {
        // Emit run.end for gap
        const runEnd: RunEvent = {
          v: 1,
          ts: this.lastEventTime / 1000 + INACTIVITY_GAP_MS / 1000,
          type: 'run',
          session_id: event.session_id,
          phase: 'end',
          run_id: this.currentRunId,
          inferred: true,
          reason: 'gap',
        };
        results.push(runEnd);
        this.currentRunId = null;
      }
    }

    // Start new run if needed
    if (this.currentRunId === null) {
      this.runCounter++;
      this.currentRunId = `run_${Date.now()}_${this.runCounter}`;
      
      // Determine reason for start
      let reason: 'after_end_marker' | 'gap' = 'after_end_marker';
      if (this.lastEventTime > 0 && now - this.lastEventTime >= INACTIVITY_GAP_MS) {
        reason = 'gap';
      }

      // Emit run.start
      const runStart: RunEvent = {
        v: 1,
        ts: event.ts,
        type: 'run',
        session_id: event.session_id,
        phase: 'start',
        run_id: this.currentRunId,
        inferred: true,
        reason,
      };
      results.push(runStart);
    }

    // Update last event time
    this.lastEventTime = now;

    // Return synthetic events first, then original event
    results.push(event);
    return results;
  }

  getCurrentRunId(): string | null {
    return this.currentRunId;
  }

  reset(): void {
    this.currentRunId = null;
    this.lastEventTime = 0;
    this.runCounter = 0;
  }
}
