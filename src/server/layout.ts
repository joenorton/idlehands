// Simplified layout: no filesystem scanning, just zone anchors for agent
export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  type: 'home';
  label: string;
}

export interface LayoutZone {
  id: string;
  x: number;
  y: number;
  label: string;
  anchorX: number; // Fixed anchor point for agent
  anchorY: number;
}

export interface Layout {
  nodes: LayoutNode[];
  zones: LayoutZone[];
}

export async function computeLayout(
  repoRoot: string,
  maxFiles: number,
  maxDepth: number,
  ignorePatterns: string[]
): Promise<Layout> {
  // Simplified layout: no filesystem scanning, just zone anchors for agent movement
  const nodes: LayoutNode[] = [];
  const zones: LayoutZone[] = [];

  const canvasWidth = 1200; // Reference width
  const canvasHeight = 800; // Reference height
  
  // Layout: activity log on left, agent + zone anchors on right
  // For centering, we'll position everything relative to the center of the full canvas
  // The renderer will handle centering within the actual canvas dimensions
  const canvasCenterX = canvasWidth / 2; // Center of full reference canvas
  const canvasCenterY = canvasHeight / 2; // Vertical center

  // Zone anchors: arranged in a triangle around the center (only activity zones, not agent states)
  const zoneAnchors = [
    { id: 'zone:reading', label: 'READ' },
    { id: 'zone:writing', label: 'WRITE' },
    { id: 'zone:executing', label: 'EXECUTING' },
  ];
  
  // Triangle parameters - centered on canvas
  // Use a radius that fits well within the canvas, ensuring equal space on all sides
  const radius = Math.min(canvasWidth, canvasHeight) * 0.25; // 25% of smaller dimension for better centering
  const numZones = zoneAnchors.length;
  
  // Arrange zones in a triangle (3 points on a circle)
  // Start at top and go clockwise
  for (let i = 0; i < numZones; i++) {
    // Angle: start at -90° (top), then go clockwise
    // Each zone is 360/3 = 120 degrees apart
    const angle = (-90 + (i * 360 / numZones)) * (Math.PI / 180);
    const anchorX = canvasCenterX + radius * Math.cos(angle);
    const anchorY = canvasCenterY + radius * Math.sin(angle);
    
    zones.push({
      id: zoneAnchors[i].id,
      x: anchorX,
      y: anchorY,
      label: zoneAnchors[i].label,
      anchorX: anchorX,
      anchorY: anchorY,
    });
  }

  // Home position (center of pentagon)
  nodes.push({
    id: 'home',
    x: canvasCenterX,
    y: canvasCenterY,
    type: 'home',
    label: '',
  });

  return { nodes, zones };
}
