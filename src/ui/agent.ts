import type { Layout } from '../server/layout.js';
import { MapRenderer } from './map.js';
import { CharacterModel } from './characterModel.js';

interface TrailPoint {
  x: number;
  y: number;
  timestamp: number;
}

export class AgentController {
  private layout: Layout | null = null;
  private mapRenderer: MapRenderer;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private currentX = 0;
  private currentY = 0;
  private targetX = 0;
  private targetY = 0;
  private isMoving = false;
  private currentActivityZone: string | null = null;
  private zoneEntryTime = 0;
  private trail: TrailPoint[] = [];
  private trailDecayTime = 2000; // Trail fades over 2 seconds
  private currentAgentState: 'thinking' | 'responding' | null = null;
  private agentStateStartTime: number = 0;
  private agentStateFadeDuration = 4000; // Fade out over 4 seconds
  private characterModel: CharacterModel;
  private currentActiveFile: string | null = null;

  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, mapRenderer: MapRenderer) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.mapRenderer = mapRenderer;
    this.characterModel = new CharacterModel();
    // Load sprites asynchronously (non-blocking)
    this.characterModel.load().catch(err => {
      console.warn('[AgentController] Failed to load character sprites:', err);
    });
  }

  getCurrentActivityZone(): string | null {
    return this.currentActivityZone;
  }

  getZoneDwellTime(): number {
    if (!this.currentActivityZone || this.zoneEntryTime === 0) return 0;
    return (Date.now() - this.zoneEntryTime) / 1000; // seconds
  }

  setAgentState(state: 'thinking' | 'responding' | null) {
    this.currentAgentState = state;
    this.agentStateStartTime = state ? Date.now() : 0;
  }

  getAgentState(): 'thinking' | 'responding' | null {
    return this.currentAgentState;
  }

  setActiveFile(filePath: string | null) {
    this.currentActiveFile = filePath;
  }

  setLayout(layout: Layout) {
    this.layout = layout;
    
    // Initialize position to home (only on layout set, which happens on session start)
    const homePos = this.mapRenderer.getNodePosition('home');
    if (homePos) {
      this.currentX = homePos.x;
      this.currentY = homePos.y;
      this.targetX = this.currentX;
      this.targetY = this.currentY;
      console.log(`[Agent] Initialized to home position: (${this.currentX}, ${this.currentY})`);
    } else {
      // Fallback to center if home not found
      this.currentX = 0;
      this.currentY = 0;
      this.targetX = this.currentX;
      this.targetY = this.currentY;
      console.warn('[Agent] Home position not found, using (0, 0)');
    }
  }

  moveToActivityZone(zoneId: string, instant: boolean = false) {
    if (!this.layout) {
      console.warn('[Agent] No layout set');
      return;
    }

    const zonePos = this.mapRenderer.getZoneAnchor(zoneId);
    if (!zonePos) {
      console.warn(`[Agent] Missing activity zone: ${zoneId}`);
      return;
    }

    // Update activity zone
    if (this.currentActivityZone !== zoneId) {
      this.currentActivityZone = zoneId;
      this.zoneEntryTime = Date.now();
    }

    this.targetX = zonePos.x;
    this.targetY = zonePos.y;

    if (instant) {
      this.currentX = this.targetX;
      this.currentY = this.targetY;
      this.isMoving = false;
      // Clear trail on instant movement
      this.trail = [];
    } else {
      this.isMoving = true;
    }
  }

  moveToHome(instant: boolean = false) {
    if (!this.layout) {
      console.warn('[Agent] No layout set');
      return;
    }

    const homePos = this.mapRenderer.getNodePosition('home');
    if (!homePos) {
      console.warn('[Agent] Home position not found');
      return;
    }

    this.currentActivityZone = null;
    this.zoneEntryTime = 0;

    this.targetX = homePos.x;
    this.targetY = homePos.y;

    if (instant) {
      this.currentX = this.targetX;
      this.currentY = this.targetY;
      this.isMoving = false;
      // Clear trail on instant movement
      this.trail = [];
    } else {
      this.isMoving = true;
    }
  }


  render() {
    const now = Date.now();
    const speed = 8; // Increased from 3 to 8 pixels per frame (faster movement)
    
    // Update position (straight-line constant-speed motion)
    if (this.isMoving) {
      const dx = this.targetX - this.currentX;
      const dy = this.targetY - this.currentY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < speed) {
        this.currentX = this.targetX;
        this.currentY = this.targetY;
        this.isMoving = false;
      } else {
        // Constant speed movement
        const moveX = (dx / distance) * speed;
        const moveY = (dy / distance) * speed;
        
        this.currentX += moveX;
        this.currentY += moveY;
      }
      
      // Add trail point while moving (sample every few frames to avoid too many points)
      if (this.trail.length === 0 || now - this.trail[this.trail.length - 1].timestamp > 16) {
        this.trail.push({
          x: this.currentX,
          y: this.currentY,
          timestamp: now,
        });
      }
    }
    
    // Remove old trail points (decay over time)
    this.trail = this.trail.filter(point => now - point.timestamp < this.trailDecayTime);
    
    // Render trail (slowly decaying)
    if (this.trail.length > 1) {
      for (let i = 0; i < this.trail.length - 1; i++) {
        const point = this.trail[i];
        const nextPoint = this.trail[i + 1];
        const age = now - point.timestamp;
        const alpha = 1 - (age / this.trailDecayTime); // Fade from 1 to 0 over decay time
        
        if (alpha > 0) {
          // Trail gets thinner and more transparent as it ages
          const trailWidth = 2 * alpha;
          const trailAlpha = alpha * 0.4; // Max 40% opacity
          
          this.ctx.strokeStyle = `rgba(0, 255, 150, ${trailAlpha})`;
          this.ctx.lineWidth = trailWidth;
          this.ctx.lineCap = 'round';
          this.ctx.lineJoin = 'round';
          
          this.ctx.beginPath();
          this.ctx.moveTo(point.x, point.y);
          this.ctx.lineTo(nextPoint.x, nextPoint.y);
          this.ctx.stroke();
        }
      }
    }

    // Update character model animation
    this.characterModel.update(now, this.currentActivityZone);

    // Get sprite from character model
    const sprite = this.characterModel.getCurrentSprite();
    const spriteSize = this.characterModel.getSpriteSize();
    const isSteadyState = !this.isMoving && this.currentActivityZone !== null;
    const dwellTime = this.getZoneDwellTime();

    // Render agent sprite or fallback to gradient
    if (sprite && this.characterModel.isReady()) {
      // Render sprite centered at agent position
      const spriteX = this.currentX - spriteSize / 2;
      const spriteY = this.currentY - spriteSize / 2;
      this.ctx.drawImage(sprite, spriteX, spriteY, spriteSize, spriteSize);

      // Optional: Add subtle glow around sprite when in steady state
      if (isSteadyState && dwellTime > 0) {
        const glowIntensity = Math.min(dwellTime / 10, 1) * 0.3;
        const outerGlow = this.ctx.createRadialGradient(
          this.currentX, this.currentY, 0,
          this.currentX, this.currentY, spriteSize / 2 + 8
        );
        outerGlow.addColorStop(0, `rgba(0, 255, 150, ${glowIntensity})`);
        outerGlow.addColorStop(0.5, `rgba(0, 255, 150, ${glowIntensity * 0.4})`);
        outerGlow.addColorStop(1, 'rgba(0, 255, 150, 0)');
        this.ctx.fillStyle = outerGlow;
        this.ctx.beginPath();
        this.ctx.arc(this.currentX, this.currentY, spriteSize / 2 + 8, 0, Math.PI * 2);
        this.ctx.fill();
      }
    } else {
      // Fallback to gradient rendering if sprites not loaded
      const fileDotSize = 2.5;
      const agentSize = fileDotSize * 3.5;
      
      // Outer glow - stronger for prominence (agent must be more visible than evidence)
      const glowIntensity = isSteadyState ? 0.5 : 0.8;
      const outerGlow = this.ctx.createRadialGradient(
        this.currentX, this.currentY, 0,
        this.currentX, this.currentY, agentSize + 8
      );
      outerGlow.addColorStop(0, `rgba(0, 255, 150, ${glowIntensity})`);
      outerGlow.addColorStop(0.5, `rgba(0, 255, 150, ${glowIntensity * 0.4})`);
      outerGlow.addColorStop(1, 'rgba(0, 255, 150, 0)');
      this.ctx.fillStyle = outerGlow;
      this.ctx.beginPath();
      this.ctx.arc(this.currentX, this.currentY, agentSize + 8, 0, Math.PI * 2);
      this.ctx.fill();

      // Main agent body with gradient - higher contrast
      const agentGradient = this.ctx.createRadialGradient(
        this.currentX - agentSize/3, this.currentY - agentSize/3, 0,
        this.currentX, this.currentY, agentSize
      );
      agentGradient.addColorStop(0, '#00ffaa'); // Brighter
      agentGradient.addColorStop(0.7, '#00dd88');
      agentGradient.addColorStop(1, '#00aa66');
      this.ctx.fillStyle = agentGradient;
      this.ctx.beginPath();
      this.ctx.arc(this.currentX, this.currentY, agentSize, 0, Math.PI * 2);
      this.ctx.fill();

      // Highlight - stronger for visibility
      const highlightAlpha = isSteadyState ? 0.4 : 0.6;
      this.ctx.fillStyle = `rgba(255, 255, 255, ${highlightAlpha})`;
      this.ctx.beginPath();
      this.ctx.arc(this.currentX - agentSize/3, this.currentY - agentSize/3, agentSize/2.5, 0, Math.PI * 2);
      this.ctx.fill();

      // Inner core - brighter
      this.ctx.fillStyle = '#00ffcc';
      this.ctx.beginPath();
      this.ctx.arc(this.currentX, this.currentY, agentSize/2.5, 0, Math.PI * 2);
      this.ctx.fill();
      
      // Outline thickness increases slowly with dwell time (no animation loops)
      if (isSteadyState && dwellTime > 0) {
        // Outline thickness: 1.5px base + up to 2px based on dwell time (capped at 10s)
        const outlineThickness = 1.5 + Math.min(dwellTime / 10, 1) * 2;
        const outlineAlpha = 0.6 + Math.min(dwellTime / 10, 1) * 0.3;
        this.ctx.strokeStyle = `rgba(0, 255, 150, ${outlineAlpha})`;
        this.ctx.lineWidth = outlineThickness;
        this.ctx.beginPath();
        this.ctx.arc(this.currentX, this.currentY, agentSize + 2, 0, Math.PI * 2);
        this.ctx.stroke();
      }
    }

    // Render active file label underneath character (temporary debug feature)
    if (this.currentActiveFile) {
      const labelY = this.currentY + (sprite ? spriteSize / 2 : 20) + 20;
      const maxWidth = 300;
      
      // Truncate long file paths
      let displayText = this.currentActiveFile;
      this.ctx.font = '16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      if (this.ctx.measureText(displayText).width > maxWidth) {
        // Show last 50 characters with "..." prefix
        const charsToShow = 50;
        displayText = '...' + displayText.slice(-charsToShow);
      }
      
      this.ctx.fillStyle = '#aaa';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'top';
      this.ctx.fillText(displayText, this.currentX, labelY);
    }
    
    // Show emoji bubble for agent states (thinking, responding) with fade-out
    // Show even when in an activity zone
    if (!this.isMoving) {
      // Get current agent state from state machine (passed via setAgentState)
      const agentState = this.getAgentState();
      if (agentState && this.agentStateStartTime > 0) {
        const age = now - this.agentStateStartTime;
        
        // Fade out after fade duration
        if (age > this.agentStateFadeDuration) {
          // Clear state after fade
          this.currentAgentState = null;
          this.agentStateStartTime = 0;
        } else {
          // Calculate fade alpha (1.0 to 0.0 over fade duration)
          const fadeStart = this.agentStateFadeDuration * 0.6; // Start fading at 60% of duration
          let alpha = 1.0;
          if (age > fadeStart) {
            alpha = 1.0 - ((age - fadeStart) / (this.agentStateFadeDuration - fadeStart));
          }
          
          const bubbleX = this.currentX;
          // Position bubble above sprite (or gradient fallback)
          const agentVisualSize = sprite ? spriteSize / 2 : (2.5 * 3.5);
          const bubbleY = this.currentY - agentVisualSize - 20;
          
          // Emoji based on state
          let bubbleEmoji = '';
          if (agentState === 'thinking') {
            bubbleEmoji = '💡'; // Lightbulb
          } else if (agentState === 'responding') {
            bubbleEmoji = '💬'; // Speech balloon
          }
          
          if (bubbleEmoji) {
            // Bubble background (fades with alpha)
            this.ctx.fillStyle = `rgba(20, 20, 30, ${0.9 * alpha})`;
            this.ctx.font = '18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            const textWidth = this.ctx.measureText(bubbleEmoji).width;
            const bubblePadding = 10;
            const bubbleW = textWidth + bubblePadding * 2;
            const bubbleH = 28;
            
            this.roundRect(bubbleX - bubbleW / 2, bubbleY - bubbleH / 2, bubbleW, bubbleH, 6);
            this.ctx.fill();
            
            // Bubble border (fades with alpha)
            this.ctx.strokeStyle = `rgba(150, 150, 150, ${0.3 * alpha})`;
            this.ctx.lineWidth = 1;
            this.roundRect(bubbleX - bubbleW / 2, bubbleY - bubbleH / 2, bubbleW, bubbleH, 6);
            this.ctx.stroke();
            
            // Bubble emoji (fades with alpha)
            this.ctx.fillStyle = `rgba(200, 200, 220, ${0.9 * alpha})`;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(bubbleEmoji, bubbleX, bubbleY);
          }
        }
      }
    }
  }
  
  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    this.ctx.beginPath();
    this.ctx.moveTo(x + r, y);
    this.ctx.arcTo(x + w, y, x + w, y + h, r);
    this.ctx.arcTo(x + w, y + h, x, y + h, r);
    this.ctx.arcTo(x, y + h, x, y, r);
    this.ctx.arcTo(x, y, x + w, y, r);
    this.ctx.closePath();
  }
}
