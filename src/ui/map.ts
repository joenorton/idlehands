import type { Layout, LayoutZone } from '../server/layout.js';

export class MapRenderer {
  private layout: Layout | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scaleX = 1;
  private scaleY = 1;
  private referenceWidth = 1200;
  private referenceHeight = 800;
  private currentActiveZone: string | null = null; // For highlighting active zone anchor
  private zonePulses: Map<string, Array<{ startTime: number; duration: number }>> = new Map();
  private maxPulsesPerZone = 5; // Limit concurrent pulses per zone
  private zoneHeartbeats: Map<string, { startTime: number; duration: number }> = new Map(); // Track heartbeat animations per zone

  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.canvas = canvas;
    this.ctx = ctx;
  }

  // Set the active zone anchor (for highlighting)
  setActiveZone(zoneId: string | null) {
    this.currentActiveZone = zoneId;
  }

  // Trigger a pulse animation on a zone
  triggerZonePulse(zoneId: string, duration: number = 800) {
    if (!this.zonePulses.has(zoneId)) {
      this.zonePulses.set(zoneId, []);
    }
    
    const pulses = this.zonePulses.get(zoneId)!;
    
    // Limit concurrent pulses
    if (pulses.length >= this.maxPulsesPerZone) {
      // Remove oldest pulse to make room
      pulses.shift();
    }
    
    // Add new pulse
    pulses.push({
      startTime: Date.now(),
      duration,
    });

    // Also trigger heartbeat effect (thump)
    this.zoneHeartbeats.set(zoneId, {
      startTime: Date.now(),
      duration: 400, // Shorter duration for quick thump
    });
  }

  setLayout(layout: Layout) {
    this.layout = layout;
    this.updateScale();
  }

  private updateScale() {
    if (!this.layout) return;
    
    // Get actual canvas display size (accounting for device pixel ratio)
    const rect = this.canvas.getBoundingClientRect();
    const displayWidth = rect.width || this.canvas.clientWidth || this.referenceWidth;
    const displayHeight = rect.height || this.canvas.clientHeight || this.referenceHeight;
    
    // Scale to fit canvas while maintaining aspect ratio
    this.scaleX = displayWidth / this.referenceWidth;
    this.scaleY = displayHeight / this.referenceHeight;
  }

  render() {
    if (!this.layout) return;

    this.updateScale();

    // Draw subtle background
    this.drawBackground();

    // Draw triangle outline connecting zone anchors (subtle guide)
    this.drawTriangleOutline();

    // Render zone anchor labels only (semantic labels, not visual containers)
    for (const zone of this.layout.zones) {
      this.renderZoneAnchor(zone);
    }
  }

  private drawTriangleOutline() {
    if (!this.layout || this.layout.zones.length !== 3) return;

    // Draw a subtle line connecting the zone anchors in order
    const zones = this.layout.zones;
    this.ctx.strokeStyle = 'rgba(100, 100, 120, 0.15)';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    
    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i];
      const x = zone.anchorX * this.scaleX;
      const y = zone.anchorY * this.scaleY;
      
      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
        this.ctx.lineTo(x, y);
      }
    }
    // Close the triangle
    this.ctx.closePath();
    this.ctx.stroke();
  }

  private drawBackground() {
    // Simple gradient background - use display size
    const rect = this.canvas.getBoundingClientRect();
    const displayWidth = rect.width || this.canvas.clientWidth || this.referenceWidth;
    const displayHeight = rect.height || this.canvas.clientHeight || this.referenceHeight;
    
    const bgGradient = this.ctx.createLinearGradient(0, 0, displayWidth, displayHeight);
    bgGradient.addColorStop(0, '#0a0a0f');
    bgGradient.addColorStop(1, '#0f0f15');
    this.ctx.fillStyle = bgGradient;
    this.ctx.fillRect(0, 0, displayWidth, displayHeight);
  }

  private renderZoneAnchor(zone: LayoutZone) {
    const x = zone.anchorX * this.scaleX;
    const y = zone.anchorY * this.scaleY;
    const isActive = this.currentActiveZone === zone.id;

    // Zone anchor colors
    const zoneColors: Record<string, string> = {
      'zone:reading': '#3b82f6',
      'zone:writing': '#f59e0b',
      'zone:executing': '#8b5cf6',
    };

    const color = zoneColors[zone.id] || '#888';
    const alpha = isActive ? 0.9 : 0.5; // Increased visibility

    // Render pulse rings before main circle
    this.renderPulseRings(zone.id, x, y, color, isActive ? 16 : 12);

    // Calculate heartbeat scale (if active)
    const baseRadius = isActive ? 16 : 12;
    const heartbeatScale = this.getHeartbeatScale(zone.id);
    const currentRadius = baseRadius * heartbeatScale;

    // Draw anchor point (larger circle for visibility in pentagon)
    this.ctx.fillStyle = color;
    this.ctx.globalAlpha = alpha;
    this.ctx.beginPath();
    this.ctx.arc(x, y, currentRadius, 0, Math.PI * 2);
    this.ctx.fill();

    // Draw subtle glow for active zone (use current radius for heartbeat)
    if (isActive) {
      this.ctx.shadowBlur = 12;
      this.ctx.shadowColor = color;
      this.ctx.beginPath();
      this.ctx.arc(x, y, currentRadius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.shadowBlur = 0;
    }

    // Draw label (positioned outward from center)
    this.ctx.fillStyle = color;
    this.ctx.globalAlpha = isActive ? 1.0 : 0.8;
    this.ctx.font = isActive ? 'bold 22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' : '18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    this.ctx.textAlign = 'center';
    
    // Position label outward from center (calculate direction from center to anchor)
    const rect = this.canvas.getBoundingClientRect();
    const displayWidth = rect.width || this.canvas.clientWidth || this.referenceWidth;
    const displayHeight = rect.height || this.canvas.clientHeight || this.referenceHeight;
    const canvasCenterX = displayWidth / 2;
    const canvasCenterY = displayHeight / 2;
    
    const dx = x - canvasCenterX;
    const dy = y - canvasCenterY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > 0) {
      // Increased offset to provide more padding between zone dot and label
      // Account for larger dots (12-16px radius) and larger text (18-22px)
      const offsetX = (dx / distance) * 50;
      const offsetY = (dy / distance) * 50;
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(zone.label, x + offsetX, y + offsetY);
    } else {
      this.ctx.textBaseline = 'top';
      this.ctx.fillText(zone.label, x, y + 18);
    }
    
    this.ctx.globalAlpha = 1.0; // Reset alpha
  }

  private renderPulseRings(zoneId: string, x: number, y: number, color: string, baseRadius: number) {
    const pulses = this.zonePulses.get(zoneId);
    if (!pulses || pulses.length === 0) return;

    const now = Date.now();
    const maxPulseRadius = baseRadius + 35; // Expand to ~35px beyond base radius
    const expiredPulses: number[] = [];

    // Parse color hex to RGB
    const hex = color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    // Render each active pulse
    pulses.forEach((pulse, index) => {
      const age = now - pulse.startTime;
      const progress = Math.min(age / pulse.duration, 1);

      if (progress >= 1) {
        // Mark as expired
        expiredPulses.push(index);
        return;
      }

      // Calculate pulse properties with ease-out easing
      const easedProgress = 1 - Math.pow(1 - progress, 3); // Cubic ease-out
      const pulseRadius = baseRadius + (maxPulseRadius - baseRadius) * easedProgress;
      const pulseAlpha = (1 - progress) * 0.6; // Fade from 60% to 0

      // Draw expanding circle
      this.ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${pulseAlpha})`;
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.arc(x, y, pulseRadius, 0, Math.PI * 2);
      this.ctx.stroke();
    });

    // Remove expired pulses (in reverse order to maintain indices)
    expiredPulses.reverse().forEach(index => {
      pulses.splice(index, 1);
    });

    // Clean up empty pulse arrays
    if (pulses.length === 0) {
      this.zonePulses.delete(zoneId);
    }
  }

  private getHeartbeatScale(zoneId: string): number {
    const heartbeat = this.zoneHeartbeats.get(zoneId);
    if (!heartbeat) return 1.0;

    const now = Date.now();
    const age = now - heartbeat.startTime;
    const progress = Math.min(age / heartbeat.duration, 1);

    if (progress >= 1) {
      // Heartbeat complete, remove it
      this.zoneHeartbeats.delete(zoneId);
      return 1.0;
    }

    // Heartbeat animation: scale from 1.0 → 1.25 → 1.0
    // Use a smooth ease-in-out curve
    const easedProgress = progress < 0.5
      ? 2 * progress * progress // Ease in
      : 1 - Math.pow(-2 * progress + 2, 2) / 2; // Ease out

    if (easedProgress < 0.5) {
      // Growing phase: 1.0 → 1.25
      return 1.0 + (0.25 * (easedProgress * 2));
    } else {
      // Shrinking phase: 1.25 → 1.0
      return 1.25 - (0.25 * ((easedProgress - 0.5) * 2));
    }
  }

  getNodePosition(nodeId: string): { x: number; y: number } | null {
    if (!this.layout) return null;

    const node = this.layout.nodes.find(n => n.id === nodeId);
    if (!node) return null;

    // Calculate position relative to actual canvas center for better centering
    const rect = this.canvas.getBoundingClientRect();
    const displayWidth = rect.width || this.canvas.clientWidth || this.referenceWidth;
    const displayHeight = rect.height || this.canvas.clientHeight || this.referenceHeight;
    
    // Calculate the center of the actual canvas
    const canvasCenterX = displayWidth / 2;
    const canvasCenterY = displayHeight / 2;
    
    // Calculate offset from reference center to node
    const referenceCenterX = this.referenceWidth / 2;
    const referenceCenterY = this.referenceHeight / 2;
    const offsetX = node.x - referenceCenterX;
    const offsetY = node.y - referenceCenterY;
    
    // Apply offset to actual canvas center
    return {
      x: canvasCenterX + (offsetX * this.scaleX),
      y: canvasCenterY + (offsetY * this.scaleY),
    };
  }

  getZoneAnchor(zoneId: string): { x: number; y: number } | null {
    if (!this.layout) return null;

    const zone = this.layout.zones.find(z => z.id === zoneId);
    if (!zone) return null;

    return {
      x: zone.anchorX * this.scaleX,
      y: zone.anchorY * this.scaleY,
    };
  }

  // Placeholder for compatibility (dwell time no longer used in simplified view)
  setZoneDwellTime(zoneId: string, dwellTime: number) {
    // No-op: dwell time not displayed in simplified anchor view
  }
}
