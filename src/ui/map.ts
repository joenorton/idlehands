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

  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.canvas = canvas;
    this.ctx = ctx;
  }

  // Set the active zone anchor (for highlighting)
  setActiveZone(zoneId: string | null) {
    this.currentActiveZone = zoneId;
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

    // Draw anchor point (larger circle for visibility in pentagon)
    this.ctx.fillStyle = color;
    this.ctx.globalAlpha = alpha;
    this.ctx.beginPath();
    this.ctx.arc(x, y, isActive ? 16 : 12, 0, Math.PI * 2);
    this.ctx.fill();

    // Draw subtle glow for active zone
    if (isActive) {
      this.ctx.shadowBlur = 12;
      this.ctx.shadowColor = color;
      this.ctx.beginPath();
      this.ctx.arc(x, y, 16, 0, Math.PI * 2);
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
