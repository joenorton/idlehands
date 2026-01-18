export class CharacterModel {
  private sprites: {
    idle: HTMLImageElement | null;
    awake: HTMLImageElement | null;
    reading: HTMLImageElement[];
    writing: HTMLImageElement[];
    executing: HTMLImageElement[];
  } = {
    idle: null,
    awake: null,
    reading: [],
    writing: [],
    executing: [],
  };

  private currentActivity: string | null = null;
  private currentFrame = 0;
  private lastFrameTime = 0;
  private frameInterval = 600; // ms per frame
  private spriteSize = 64; // Default sprite size in pixels
  private isLoaded = false;

  async load(): Promise<void> {
    const basePath = '/assets/';
    
    // Load static sprites
    const staticSprites = [
      { key: 'idle', path: `${basePath}agent_idle.png` },
      { key: 'awake', path: `${basePath}agent_awake.png` },
    ];

    // Load animation sprites (3 frames each)
    const animationSprites = [
      { key: 'reading', frames: 3 },
      { key: 'writing', frames: 3 },
      { key: 'executing', frames: 3 },
    ];

    const loadPromises: Promise<void>[] = [];

    // Load static sprites
    for (const sprite of staticSprites) {
      const promise = new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          (this.sprites as any)[sprite.key] = img;
          // Detect sprite size from first loaded image
          if (!this.isLoaded && img.width > 0) {
            this.spriteSize = img.width;
          }
          resolve();
        };
        img.onerror = () => {
          console.warn(`[CharacterModel] Failed to load sprite: ${sprite.path}`);
          (this.sprites as any)[sprite.key] = null;
          resolve(); // Continue even if sprite fails to load
        };
        img.src = sprite.path;
      });
      loadPromises.push(promise);
    }

    // Load animation sprites
    for (const sprite of animationSprites) {
      for (let i = 1; i <= sprite.frames; i++) {
        const promise = new Promise<void>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            (this.sprites as any)[sprite.key].push(img);
            // Detect sprite size from first loaded image
            if (!this.isLoaded && img.width > 0) {
              this.spriteSize = img.width;
            }
            resolve();
          };
          img.onerror = () => {
            console.warn(`[CharacterModel] Failed to load sprite: ${basePath}${sprite.key}_${i}.png`);
            resolve(); // Continue even if sprite fails to load
          };
          img.src = `${basePath}${sprite.key}_${i}.png`;
        });
        loadPromises.push(promise);
      }
    }

    await Promise.all(loadPromises);
    this.isLoaded = true;
  }

  update(now: number, activityZone: string | null): void {
    // Reset frame when activity changes
    if (activityZone !== this.currentActivity) {
      this.currentActivity = activityZone;
      this.currentFrame = 0;
      this.lastFrameTime = now;
      return;
    }

    // Only animate if we're in an activity zone with animation frames
    const hasAnimation = activityZone !== null && 
      (activityZone === 'zone:reading' || 
       activityZone === 'zone:writing' || 
       activityZone === 'zone:executing');

    if (hasAnimation) {
      // Advance frame on timer
      if (now - this.lastFrameTime >= this.frameInterval) {
        // Simple loop: 0→1→2→0→1→2... (3 frames)
        const frameCount = 3;
        this.currentFrame = (this.currentFrame + 1) % frameCount;
        this.lastFrameTime = now;
      }
    }
  }

  getCurrentSprite(): HTMLImageElement | null {
    if (!this.isLoaded) {
      return null;
    }

    if (this.currentActivity === null) {
      // Use idle or awake (prefer awake if available, otherwise idle)
      return this.sprites.awake || this.sprites.idle;
    }

    // Get animation frames based on activity
    let frames: HTMLImageElement[] = [];
    if (this.currentActivity === 'zone:reading') {
      frames = this.sprites.reading;
    } else if (this.currentActivity === 'zone:writing') {
      frames = this.sprites.writing;
    } else if (this.currentActivity === 'zone:executing') {
      frames = this.sprites.executing;
    }

    // Return current frame, or first frame if current frame is out of bounds
    if (frames.length > 0 && this.currentFrame < frames.length) {
      return frames[this.currentFrame];
    }

    // Fallback to idle if no frames available
    return this.sprites.idle;
  }

  getSpriteSize(): number {
    return this.spriteSize;
  }

  isReady(): boolean {
    return this.isLoaded;
  }
}
