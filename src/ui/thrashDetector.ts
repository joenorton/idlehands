import type { Event, FileTouchEvent, ToolCallEvent, ThrashStartEvent, ThrashEndEvent, RunEvent } from '../model/events.js';

enum EventBucket {
  PROGRESS_CODE = 'PROGRESS_CODE',
  PROGRESS_DOC = 'PROGRESS_DOC',
  VALIDATE = 'VALIDATE',
  RESEARCH = 'RESEARCH',
  READ = 'READ',
  CONTROL = 'CONTROL',
}

type ThrashSignature = 'internet_only' | 'internet_test_loop' | 'test_only' | 'switch_frenzy';

type ThrashState = 'NORMAL' | 'CHURN' | 'THRASH';

interface WindowEvent {
  ts: number;
  bucket: EventBucket;
  key?: string; // "tool:target" for repeat detection
}

interface ThrashEvidence {
  duration: number;
  researchCalls: number;
  testRestarts: number;
  writes: number;
  writesCode: number;
  longestNoProgressGap: number;
  switchRate: number;
  confidence: 'low' | 'medium' | 'high';
}

// Configuration constants
const WINDOW_30S = 30000;
const WINDOW_90S = 90000;
const INACTIVITY_GAP = 30000;

// Thrash trigger thresholds
const RESEARCH_STORM_THRESHOLD = 6; // research_30s >= 6
const VALIDATION_SPAM_THRESHOLD = 2; // tests_90s >= 2
const REPEAT_LOOP_THRESHOLD = 4; // repeat_max_30s >= 4 (5+ calls)
const SWITCH_FRENZY_RATE = 0.45; // switch_rate_30s >= 0.45

// Hysteresis
const MIN_SPAN_DURATION_MS = 8000; // 8-10s minimum
const COOLDOWN_MS = 10000; // 10s cooldown after end
const GRACE_PERIOD_MS = 15000; // 15s grace period or first PROGRESS_CODE

export class ThrashDetector {
  private events: WindowEvent[] = []; // Single deque for 90s window
  private currentRunId: string | null = null;
  private runStartTime: number = 0;
  private firstProgressCodeTime: number | null = null;

  // Thrash state
  private state: ThrashState = 'NORMAL';
  private thrashStartTime: number = 0;
  private thrashSignature: ThrashSignature | null = null;
  private lastThrashEndTime: number = 0;
  private consecutiveThrashEvals: number = 0;
  private lastStateEvalTime: number = 0;

  // Validation spam tracking
  private lastValidateTime: number = 0;
  private writesAfterLastValidate: number = 0;

  // Progress tracking
  private lastProgressCodeTime: number = 0;
  private longestNoProgressGap: number = 0;
  private thrashSpanStartProgressTime: number = 0;

  // Bucket counters (computed from events deque)
  private getBucketCounts(windowMs: number): Map<EventBucket, number> {
    const cutoff = Date.now() - windowMs;
    const counts = new Map<EventBucket, number>();
    for (const evt of this.events) {
      if (evt.ts >= cutoff) {
        counts.set(evt.bucket, (counts.get(evt.bucket) || 0) + 1);
      }
    }
    return counts;
  }

  private categorizeEvent(event: Event): EventBucket | null {
    if (event.type === 'file_touch') {
      const ft = event as FileTouchEvent;
      if (ft.kind === 'write') {
        // Classify as code or doc
        const path = ft.path.toLowerCase();
        if (path.includes('src/') || path.includes('dist/') || 
            path.endsWith('.ts') || path.endsWith('.js') || 
            path.endsWith('.tsx') || path.endsWith('.jsx')) {
          return EventBucket.PROGRESS_CODE;
        } else {
          return EventBucket.PROGRESS_DOC;
        }
      } else if (ft.kind === 'read') {
        return EventBucket.READ;
      }
    } else if (event.type === 'tool_call') {
      const tc = event as ToolCallEvent;
      // IGNORE tool_call end events - don't count for storms
      if (tc.phase === 'end') {
        return null;
      }
      if (tc.tool === 'tests' && tc.phase === 'start') {
        return EventBucket.VALIDATE;
      }
      if (tc.tool === 'internet' && tc.phase === 'start') {
        return EventBucket.RESEARCH;
      }
    } else if (event.type === 'session' || event.type === 'agent_state') {
      return EventBucket.CONTROL;
    }
    // Ignore run, thrash, unknown events for categorization
    return null;
  }

  private getToolTargetKey(event: Event): string | undefined {
    if (event.type === 'tool_call') {
      const tc = event as ToolCallEvent;
      const target = tc.command || '';
      return `${tc.tool}:${target}`;
    }
    return undefined;
  }

  private getMaxRepeat30s(): number {
    const cutoff = Date.now() - WINDOW_30S;
    const toolTargetCounts = new Map<string, number>();
    for (const evt of this.events) {
      if (evt.ts >= cutoff && evt.key) {
        toolTargetCounts.set(evt.key, (toolTargetCounts.get(evt.key) || 0) + 1);
      }
    }
    let max = 0;
    for (const count of toolTargetCounts.values()) {
      if (count > max) max = count;
    }
    return max;
  }

  private getSwitchRate30s(): number {
    const cutoff = Date.now() - WINDOW_30S;
    const windowEvents = this.events.filter(e => e.ts >= cutoff);
    if (windowEvents.length < 2) return 0;
    
    let switches = 0;
    for (let i = 1; i < windowEvents.length; i++) {
      if (windowEvents[i].bucket !== windowEvents[i - 1].bucket) {
        switches++;
      }
    }
    return switches / (windowEvents.length - 1);
  }

  private evaluateThrash(): ThrashState {
    const now = Date.now();
    const runAge = this.currentRunId ? now - this.runStartTime : 0;

    // Grace period: don't allow THRASH until run age >= 15s OR first PROGRESS_CODE
    const inGracePeriod = runAge < GRACE_PERIOD_MS && this.firstProgressCodeTime === null;

    // Cooldown: after thrash ends, require stronger evidence for 10s
    const inCooldown = now - this.lastThrashEndTime < COOLDOWN_MS;

    const buckets30s = this.getBucketCounts(WINDOW_30S);
    const buckets90s = this.getBucketCounts(WINDOW_90S);

    const research30s = buckets30s.get(EventBucket.RESEARCH) || 0;
    const research90s = buckets90s.get(EventBucket.RESEARCH) || 0;
    const progressCode90s = buckets90s.get(EventBucket.PROGRESS_CODE) || 0;
    const tests90s = buckets90s.get(EventBucket.VALIDATE) || 0;
    const repeatMax30s = this.getMaxRepeat30s();
    const switchRate30s = this.getSwitchRate30s();

    // Check triggers
    const researchStorm = research30s >= RESEARCH_STORM_THRESHOLD && progressCode90s === 0;
    const validationSpam = tests90s >= VALIDATION_SPAM_THRESHOLD && this.writesAfterLastValidate === 0;
    const repeatLoop = repeatMax30s >= REPEAT_LOOP_THRESHOLD;
    const switchFrenzy = switchRate30s >= SWITCH_FRENZY_RATE && progressCode90s === 0;

    const triggerCount = [researchStorm, validationSpam, repeatLoop, switchFrenzy].filter(Boolean).length;

    // Determine state
    if (triggerCount >= 2 && !inGracePeriod) {
      // Check if we should enter THRASH
      if (this.state === 'THRASH') {
        // Already in thrash - check if we should exit
        if (progressCode90s > 0) {
          // Progress happened - exit immediately
          return 'NORMAL';
        }
        // Still in thrash
        return 'THRASH';
      } else {
        // Not in thrash yet - check hysteresis
        const timeSinceLastEval = now - this.lastStateEvalTime;
        if (timeSinceLastEval >= 5000 || this.consecutiveThrashEvals >= 2) {
          // Sustained for 5s or 2 consecutive evals
          if (!inCooldown) {
            return 'THRASH';
          }
        }
        // Not sustained yet or in cooldown - CHURN
        return 'CHURN';
      }
    } else if (triggerCount === 1 && !inGracePeriod) {
      return 'CHURN';
    } else {
      return 'NORMAL';
    }
  }

  private getThrashSignature(): ThrashSignature {
    const buckets30s = this.getBucketCounts(WINDOW_30S);
    const research30s = buckets30s.get(EventBucket.RESEARCH) || 0;
    const tests30s = buckets30s.get(EventBucket.VALIDATE) || 0;
    const switchRate30s = this.getSwitchRate30s();

    if (research30s > 0 && tests30s > 0) {
      return 'internet_test_loop';
    } else if (research30s > 0) {
      return 'internet_only';
    } else if (tests30s > 0) {
      return 'test_only';
    } else {
      return 'switch_frenzy';
    }
  }

  private getThrashEvidence(): ThrashEvidence {
    const now = Date.now();
    const duration = (now - this.thrashStartTime) / 1000;

    const buckets90s = this.getBucketCounts(WINDOW_90S);
    const researchCalls = buckets90s.get(EventBucket.RESEARCH) || 0;
    const testRestarts = buckets90s.get(EventBucket.VALIDATE) || 0;
    const writes = (buckets90s.get(EventBucket.PROGRESS_CODE) || 0) + (buckets90s.get(EventBucket.PROGRESS_DOC) || 0);
    const writesCode = buckets90s.get(EventBucket.PROGRESS_CODE) || 0;
    const switchRate = this.getSwitchRate30s();

    // Determine confidence
    let confidence: 'low' | 'medium' | 'high' = 'low';
    if (duration > 30 && researchCalls + testRestarts > 10) {
      confidence = 'high';
    } else if (duration > 15 && researchCalls + testRestarts > 5) {
      confidence = 'medium';
    }

    return {
      duration,
      researchCalls,
      testRestarts,
      writes,
      writesCode,
      longestNoProgressGap: this.longestNoProgressGap / 1000, // Convert to seconds
      switchRate,
      confidence,
    };
  }

  processEvent(event: Event, currentRunId: string | null): Event[] {
    const results: Event[] = [];

    // Handle run boundaries
    if (event.type === 'run') {
      const re = event as RunEvent;
      if (re.phase === 'start') {
        // Dev assertion: thrash cannot be active across run boundary
        if (this.state === 'THRASH') {
          console.error('[ThrashDetector] ASSERTION FAILED: thrash active across run boundary');
        }
        this.currentRunId = re.run_id;
        this.runStartTime = Date.now();
        this.firstProgressCodeTime = null;
        this.lastProgressCodeTime = 0;
        this.longestNoProgressGap = 0;
        this.writesAfterLastValidate = 0;
        this.lastValidateTime = 0;
        // Reset thrash state on new run
        if (this.state === 'THRASH') {
          // Emit thrash.end if we were in thrash
          const evidence = this.getThrashEvidence();
          const thrashEnd: ThrashEndEvent = {
            v: 1,
            ts: event.ts,
            type: 'thrash',
            session_id: event.session_id,
            phase: 'end',
            run_id: this.currentRunId!,
            signature: this.thrashSignature!,
            evidence,
          };
          results.push(thrashEnd);
        }
        this.state = 'NORMAL';
        this.thrashStartTime = 0;
        this.thrashSignature = null;
        this.lastThrashEndTime = 0;
        this.consecutiveThrashEvals = 0;
      } else if (re.phase === 'end') {
        // End current run
        if (this.state === 'THRASH') {
          // Emit thrash.end
          const evidence = this.getThrashEvidence();
          const thrashEnd: ThrashEndEvent = {
            v: 1,
            ts: event.ts,
            type: 'thrash',
            session_id: event.session_id,
            phase: 'end',
            run_id: this.currentRunId!,
            signature: this.thrashSignature!,
            evidence,
          };
          results.push(thrashEnd);
        }
        this.currentRunId = null;
        this.state = 'NORMAL';
        this.thrashStartTime = 0;
        this.thrashSignature = null;
      }
      // Return run event as-is
      results.push(event);
      return results;
    }

    // Only process events within a run
    if (this.currentRunId === null) {
      return [event];
    }

    // Categorize event
    const bucket = this.categorizeEvent(event);
    if (bucket !== null) {
      const now = Date.now();
      const key = this.getToolTargetKey(event);

      // Add to events deque
      this.events.push({
        ts: now,
        bucket,
        key,
      });

      // Clean old events (keep only last 90s)
      const cutoff = now - WINDOW_90S;
      this.events = this.events.filter(e => e.ts >= cutoff);

      // Update progress tracking
      if (bucket === EventBucket.PROGRESS_CODE) {
        if (this.firstProgressCodeTime === null) {
          this.firstProgressCodeTime = now;
        }
        if (this.lastProgressCodeTime > 0) {
          const gap = now - this.lastProgressCodeTime;
          if (gap > this.longestNoProgressGap) {
            this.longestNoProgressGap = gap;
          }
        }
        this.lastProgressCodeTime = now;
        this.writesAfterLastValidate++;
      }

      // Update validation spam tracking
      if (bucket === EventBucket.VALIDATE) {
        this.lastValidateTime = now;
        this.writesAfterLastValidate = 0; // Reset on new validate
      }

      // Update thrash span progress tracking
      if (this.state === 'THRASH' && bucket === EventBucket.PROGRESS_CODE) {
        if (this.thrashSpanStartProgressTime === 0) {
          this.thrashSpanStartProgressTime = now;
        } else {
          const gap = now - this.thrashSpanStartProgressTime;
          if (gap > this.longestNoProgressGap) {
            this.longestNoProgressGap = gap;
          }
          this.thrashSpanStartProgressTime = now;
        }
      }
    }

    // Evaluate thrash state
    const newState = this.evaluateThrash();
    const now = Date.now();
    const timeSinceLastEval = now - this.lastStateEvalTime;

    if (newState === 'THRASH' && this.state !== 'THRASH') {
      // Entering thrash
      if (timeSinceLastEval >= 5000 || this.consecutiveThrashEvals >= 2) {
        // Check minimum span duration (will be enforced on exit)
        this.thrashStartTime = now;
        this.thrashSignature = this.getThrashSignature();
        this.consecutiveThrashEvals = 0;
        this.thrashSpanStartProgressTime = this.lastProgressCodeTime || now; // Initialize to last progress or now
        this.longestNoProgressGap = 0;

        // Emit thrash.start
        const thrashStart: ThrashStartEvent = {
          v: 1,
          ts: event.ts,
          type: 'thrash',
          session_id: event.session_id,
          phase: 'start',
          run_id: this.currentRunId,
          signature: this.thrashSignature,
        };
        results.push(thrashStart);
        console.log('[ThrashDetector] thrash.start:', this.thrashSignature);
      }
      this.consecutiveThrashEvals++;
    } else if (this.state === 'THRASH' && newState !== 'THRASH') {
      // Exiting thrash
      const spanDuration = now - this.thrashStartTime;
      if (spanDuration >= MIN_SPAN_DURATION_MS) {
        // Emit thrash.end
        const evidence = this.getThrashEvidence();
        const thrashEnd: ThrashEndEvent = {
          v: 1,
          ts: event.ts,
          type: 'thrash',
          session_id: event.session_id,
          phase: 'end',
          run_id: this.currentRunId,
          signature: this.thrashSignature!,
          evidence,
        };
        results.push(thrashEnd);
        console.log('[ThrashDetector] thrash.end:', evidence);
        this.lastThrashEndTime = now;
      } else {
        // Span too short - don't emit, just reset
        console.log('[ThrashDetector] thrash span too short, not emitting');
      }
      this.thrashStartTime = 0;
      this.thrashSignature = null;
      this.consecutiveThrashEvals = 0;
    } else if (newState === 'THRASH') {
      this.consecutiveThrashEvals = 0; // Reset counter when sustained
    }

    this.state = newState;
    this.lastStateEvalTime = now;

    // Return synthetic events first, then original
    results.push(event);
    return results;
  }

  getState(): ThrashState {
    return this.state;
  }

  getMetrics(): { research30s: number; tests90s: number; progressCode90s: number; switchRate30s: number; repeatMax30s: number } {
    const buckets30s = this.getBucketCounts(WINDOW_30S);
    const buckets90s = this.getBucketCounts(WINDOW_90S);
    return {
      research30s: buckets30s.get(EventBucket.RESEARCH) || 0,
      tests90s: buckets90s.get(EventBucket.VALIDATE) || 0,
      progressCode90s: buckets90s.get(EventBucket.PROGRESS_CODE) || 0,
      switchRate30s: this.getSwitchRate30s(),
      repeatMax30s: this.getMaxRepeat30s(),
    };
  }
}
