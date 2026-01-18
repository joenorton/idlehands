import type { Event } from '../model/events.js';

const EVENT_COLORS: Record<string, string> = {
  'file_touch': '#6b8dd6', // Subtle blue for files
  'tool_call': '#8b5cf6',   // Subtle purple for tools
  'session': '#10b981',
  'unknown': '#888',
};

export class Timeline {
  private container: HTMLElement;
  private events: Event[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
  }

  setEvents(events: Event[]) {
    this.events = events;
    this.render();
  }

  addEvent(event: Event) {
    this.events.push(event);
    this.render();
  }

  render() {

    // Clear container
    this.container.innerHTML = '';

    if (this.events.length === 0) {
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = this.container.clientWidth;
    canvas.height = this.container.clientHeight;
    const ctx = canvas.getContext('2d')!;

    // Background
    ctx.fillStyle = '#151515';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const now = Date.now() / 1000;
    // Show last 5 minutes only
    const windowSize = 300; // 5 minutes
    const lastTs = now;
    const firstTs = lastTs - windowSize;
    const range = windowSize;

    // Draw event ticks with subtle type colors
    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];
      
      // Only show events in visible range
      if (event.ts < firstTs || event.ts > lastTs) continue;
      
      const x = ((event.ts - firstTs) / range) * canvas.width;
      const color = EVENT_COLORS[event.type] || '#888';
      
      // Subtle coloring
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }

    // Draw 'now' line
    const nowX = ((now - firstTs) / range) * canvas.width;
    if (nowX >= 0 && nowX <= canvas.width) {
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(nowX, 0);
      ctx.lineTo(nowX, canvas.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    this.container.appendChild(canvas);
  }
}
