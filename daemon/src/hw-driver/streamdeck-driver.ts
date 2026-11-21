import type { StreamDeck } from '@elgato-stream-deck/node';
import { DatabaseService } from '../db';

// Carga perezosa de las libs nativas (node-hid): si faltan o fallan,
// el driver queda "sin hardware" en vez de tumbar el daemon/API.
let elgatoMod: any = null;
let elgatoFailed = false;
async function getElgato(): Promise<any | null> {
  if (elgatoMod) return elgatoMod;
  if (elgatoFailed) return null;
  try {
    elgatoMod = await import('@elgato-stream-deck/node');
    return elgatoMod;
  } catch (e) {
    elgatoFailed = true;
    console.warn('⚠️ HID Elgato no disponible (modo sin hardware):', e instanceof Error ? e.message : e);
    return null;
  }
}

async function getJpeg(): Promise<((w: number, h: number, bg: any, fg: any) => Promise<Buffer>) | null> {
  try {
    const m = await import('@elgato-stream-deck/node-lib');
    return m.encodeJPEG;
  } catch (e) {
    console.warn('⚠️ encodeJPEG no disponible:', e instanceof Error ? e.message : e);
    return null;
  }
}

// canvas también es nativo: perezoso para no tumbar el daemon sin él.
let canvasMod: any = null;
let canvasFailed = false;
async function getCanvas(): Promise<any | null> {
  if (canvasMod) return canvasMod;
  if (canvasFailed) return null;
  try {
    canvasMod = await import('@napi-rs/canvas');
    return canvasMod;
  } catch (e) {
    canvasFailed = true;
    console.warn('⚠️ canvas no disponible (render HW desactivado):', e instanceof Error ? e.message : e);
    return null;
  }
}

// Cache del módulo 'lucide' (paquete grande): un solo import en vez de
// uno por botón. Sin esto, cada render de icono re-parsea el paquete
// en el hilo principal y retrasa segundos el arranque con HW conectado.
let lucideModulePromise: Promise<any> | null = null;
function getLucideModule(): Promise<any> {
  if (!lucideModulePromise) {
    lucideModulePromise = import('lucide').catch((e) => {
      lucideModulePromise = null;
      throw e;
    });
  }
  return lucideModulePromise;
}

export class StreamDeckDriver {
  private streamDeck: StreamDeck | null = null;
  private connectedDevice: string | null = null;

  /** Lista dispositivos sin tumbar nada si no hay HID. */
  async listDevices(): Promise<any[]> {
    const mod = await getElgato();
    if (!mod) return [];
    try {
      return await mod.listStreamDecks();
    } catch (e) {
      console.warn('⚠️ listStreamDecks falló:', e instanceof Error ? e.message : e);
      return [];
    }
  }

  async connect(devicePath?: string): Promise<boolean> {
    try {
      console.log('🔌 Attempting to connect to StreamDeck...');

      const mod = await getElgato();
      if (!mod) {
        console.log('ℹ️ Sin soporte HID: no se puede conectar al StreamDeck físico');
        return false;
      }
      const devices = await this.listDevices();
      console.log(`📋 Found ${devices.length} StreamDeck devices:`, devices);

      if (devices.length === 0) {
        console.log('❌ No StreamDeck devices found');
        return false;
      }

      // Use provided device path or first available device
      const targetDevice = devicePath || devices[0].path;
      console.log(`🎯 Connecting to device: ${targetDevice}`);

      if (this.streamDeck) {
        console.log('🔌 Disconnecting existing connection...');
        await this.disconnect();
      }

      console.log('🔌 Opening StreamDeck connection...');
      this.streamDeck = await mod.openStreamDeck(targetDevice);
      this.connectedDevice = targetDevice;

      console.log('✅ StreamDeck connected successfully');
      
      this.setupEventHandlers();
      console.log('🎧 Event handlers set up');

      // Initialize all buttons to red (for testing)
      console.log('🎨 Initializing buttons...');
      await this.initializeButtons();

      console.log(`🎛️ Connected to StreamDeck: ${targetDevice}`);

      // Try to update with current page if available
      // This will be called from the API route after connection
      return true;
    } catch (error) {
      console.error('❌ Failed to connect to StreamDeck:', error);
      console.error('❌ Stack trace:', error.stack);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.streamDeck) {
      this.streamDeck.removeAllListeners();
      await this.streamDeck.close();
      this.streamDeck = null;
      this.connectedDevice = null;
      console.log('Disconnected from StreamDeck');
    }
  }

  private setupEventHandlers(): void {
    if (!this.streamDeck) return;

    this.streamDeck.on('down', async (keyInfo) => {
      // keyInfo might be an object with index property, or just the index number
      const keyIndex = typeof keyInfo === 'object' && keyInfo !== null ? keyInfo.index || keyInfo.keyIndex || 0 : keyInfo;
      console.log(`StreamDeck button ${keyIndex} pressed`);
      await this.handleButtonPress(keyIndex);
    });

    this.streamDeck.on('up', (keyInfo) => {
      const keyIndex = typeof keyInfo === 'object' && keyInfo !== null ? keyInfo.index || keyInfo.keyIndex || 0 : keyInfo;
      console.log(`StreamDeck button ${keyIndex} released`);
    });

    this.streamDeck.on('error', (error) => {
      console.error('StreamDeck error:', error);
    });
  }

  getConnectedDevice(): string | null {
    return this.connectedDevice;
  }

  isConnected(): boolean {
    return this.streamDeck !== null;
  }

  /**
   * Número de teclas del dispositivo conectado (6/15/32 según modelo).
   * Sin hardware conectado devuelve el fallback clásico de 15.
   */
  getKeyCount(): number {
    try {
      const controls = (this.streamDeck as any)?.CONTROLS;
      if (Array.isArray(controls)) {
        const n = controls.filter((c: any) => c?.type === 'button').length;
        if (Number.isInteger(n) && n > 0) return n;
      }
    } catch { /* fallback */ }
    return 15;
  }

  /**
   * Geometría (filas/columnas) derivada de los controles del dispositivo.
   * Null si no hay hardware conectado.
   */
  getGridGeometry(): { cols: number; rows: number } | null {
    try {
      const controls = (this.streamDeck as any)?.CONTROLS;
      if (Array.isArray(controls)) {
        const btns = controls.filter((c: any) => c?.type === 'button');
        if (btns.length > 0) {
          const cols = Math.max(...btns.map((c: any) => Number(c.column) || 0)) + 1;
          const rows = Math.max(...btns.map((c: any) => Number(c.row) || 0)) + 1;
          return { cols, rows };
        }
      }
    } catch { /* sin geometría */ }
    return null;
  }

  async testStreamDeck(): Promise<void> {
    if (!this.streamDeck) {
      console.log('❌ StreamDeck not connected, cannot run test');
      return;
    }

    console.log('🧪 Running StreamDeck color test...');
    const keyCount = this.getKeyCount();
    const colors: Array<[number, number, number]> = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ];
    try {
      for (const [r, g, b] of colors) {
        for (let i = 0; i < keyCount; i++) {
          await this.setButtonColor(i, r, g, b);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
      }
      console.log('✅ StreamDeck color test completed, restoring page...');
    } catch (error) {
      console.error('❌ Error during StreamDeck test:', error);
    }
    // Restaurar la página actual tras el test
    try {
      const db = new DatabaseService();
      const pageId = db.getSetting('current.page_id');
      if (pageId && pageId !== 'null' && pageId !== '') {
        await this.updateFromPage(pageId);
      }
    } catch (error) {
      console.error('❌ Failed to restore StreamDeck after test:', error);
    }
  }

  async setButtonColor(keyIndex: number, r: number, g: number, b: number): Promise<void> {
    if (!this.streamDeck) {
      console.log(`❌ StreamDeck not connected, cannot set color for button ${keyIndex}`);
      return;
    }

    console.log(`🎨 Setting button ${keyIndex} to color RGB(${r}, ${g}, ${b})`);
    
    try {
      // Try using fillKeyColor first (simpler method)
      console.log(`🔄 Trying fillKeyColor for button ${keyIndex}...`);
      await this.streamDeck.fillKeyColor(keyIndex, r, g, b);
      console.log(`✅ fillKeyColor successful for button ${keyIndex}`);
    } catch (error) {
      console.error(`❌ fillKeyColor failed for button ${keyIndex}:`, error);
      
      // Fallback to fillKeyBuffer with a simple BMP image
      try {
        console.log(`🔄 Generating BMP image for button ${keyIndex}...`);
        const bmpBuffer = this.generateBMPImage(r, g, b);
        console.log(`📸 Generated BMP buffer, size: ${bmpBuffer.length} bytes`);
        
        console.log(`🔄 Calling fillKeyBuffer for button ${keyIndex}...`);
        await this.streamDeck.fillKeyBuffer(keyIndex, bmpBuffer);
        console.log(`✅ fillKeyBuffer with BMP successful for button ${keyIndex}`);
      } catch (fallbackError) {
        console.error(`❌ fillKeyBuffer with BMP also failed for button ${keyIndex}:`, fallbackError);
      }
    }
  }

  async setButtonImage(keyIndex: number, imageBuffer: Buffer): Promise<void> {
    if (this.streamDeck) {
      await this.streamDeck.fillKeyBuffer(keyIndex, imageBuffer);
    }
  }

  async initializeButtons(): Promise<void> {
    if (!this.streamDeck) {
      console.log('❌ StreamDeck not connected, cannot initialize buttons');
      return;
    }

    console.log('🎛️ Initializing all StreamDeck buttons...');
    const keyCount = this.getKeyCount();

    try {
      // Poner todas las teclas en rojo inicialmente (color de test)
      for (let i = 0; i < keyCount; i++) {
        console.log(`🔄 Initializing button ${i} to RED...`);
        await this.setButtonColor(i, 255, 0, 0);
        console.log(`✅ Button ${i} initialized`);
      }
      console.log('🎛️ StreamDeck buttons initialized successfully');
    } catch (error) {
      console.error('❌ Error initializing StreamDeck buttons:', error);
    }
  }

  generateBMPImage(r: number, g: number, b: number): Buffer {
    const width = 72;
    const height = 72;
    
    // BMP header (simplified 24-bit BMP)
    const headerSize = 54;
    const imageSize = width * height * 3;
    const fileSize = headerSize + imageSize;
    
    const buffer = Buffer.alloc(fileSize);
    
    // BMP file header
    buffer.write('BM', 0); // Signature
    buffer.writeUInt32LE(fileSize, 2); // File size
    buffer.writeUInt32LE(0, 6); // Reserved
    buffer.writeUInt32LE(headerSize, 10); // Data offset
    
    // BMP info header
    buffer.writeUInt32LE(40, 14); // Header size
    buffer.writeInt32LE(width, 18); // Width
    buffer.writeInt32LE(height, 22); // Height
    buffer.writeUInt16LE(1, 26); // Planes
    buffer.writeUInt16LE(24, 28); // Bits per pixel
    buffer.writeUInt32LE(0, 30); // Compression
    buffer.writeUInt32LE(imageSize, 34); // Image size
    buffer.writeInt32LE(0, 38); // X pixels per meter
    buffer.writeInt32LE(0, 42); // Y pixels per meter
    buffer.writeUInt32LE(0, 46); // Colors used
    buffer.writeUInt32LE(0, 50); // Important colors
    
    // BMP pixel data (BGR format, bottom-up)
    let offset = headerSize;
    for (let y = height - 1; y >= 0; y--) {
      for (let x = 0; x < width; x++) {
        buffer[offset++] = b; // Blue
        buffer[offset++] = g; // Green
        buffer[offset++] = r; // Red
      }
      // BMP rows must be padded to 4-byte boundaries
      // For 72 pixels * 3 bytes = 216 bytes per row
      // 216 % 4 = 0, so no padding needed
    }
    
    return buffer;
  }

  async generateButtonImage(buttonData: any): Promise<Buffer> {
    const width = 72;
    const height = 72;

    const canvasLib = await getCanvas();
    if (!canvasLib) throw new Error('canvas no disponible: no se puede renderizar la tecla');

    // Intentar usar Bun.Image si está disponible (Bun 1.3.13+), fallback a canvas
    // Por ahora usamos canvas pero con soporte para valores dinámicos y iconos
    const canvas = canvasLib.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // Fondo: usar backgroundColor del botón o negro
    const bg = buttonData.backgroundColor || '#000000';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    
    // Color de texto
    ctx.fillStyle = buttonData.textColor || '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Determinar qué texto mostrar — prioridad: dynamicValue > emoji > label > textTop/textBottom > icon > acción
    let displayText = '';
    let fontSize = 14;
    
    // 1) Valor dinámico (pc-vitals, etc.) — ya viene en buttonData.dynamicValue desde frontend o driver
    if (buttonData.dynamicValue !== undefined && buttonData.dynamicValue !== null && String(buttonData.dynamicValue).trim() !== '') {
      displayText = String(buttonData.dynamicValue).trim();
      // Para valores como "45%" o "65°C", usar fuente grande
      fontSize = displayText.length > 6 ? 16 : 22;
      ctx.font = `bold ${fontSize}px Arial`;
    } else if (buttonData.emoji && buttonData.emoji.trim()) {
      displayText = buttonData.emoji.trim();
      ctx.font = '32px Arial';
    } else if (buttonData.label && buttonData.label.trim()) {
      displayText = buttonData.label.trim();
      fontSize = displayText.length > 10 ? 14 : displayText.length > 5 ? 18 : 24;
      ctx.font = `${fontSize}px Arial`;
    } else if (buttonData.textTop && buttonData.textTop.trim()) {
      displayText = buttonData.textTop.trim();
      ctx.font = '16px Arial';
    } else if (buttonData.textBottom && buttonData.textBottom.trim()) {
      displayText = buttonData.textBottom.trim();
      ctx.font = '16px Arial';
    } else if (buttonData.icon && buttonData.icon.trim()) {
      // Icon es nombre lucide (ej: ArrowBigDownIcon) — renderizar SVG real con lucide
      const iconName = buttonData.icon.replace(/Icon$/, '');
      const hasIcon = await this.tryDrawLucideIcon(ctx, iconName, width, height, buttonData.textColor || '#FFFFFF');
      if (hasIcon) {
        // Icono dibujado, no necesita texto
        // Flip y convertir a buffer directamente
        const flippedCanvas = canvasLib.createCanvas(width, height);
        const flippedCtx = flippedCanvas.getContext('2d');
        flippedCtx.scale(1, -1);
        flippedCtx.translate(0, -height);
        flippedCtx.drawImage(canvas, 0, 0);
        return this.canvasToRGBBuffer(flippedCanvas);
      } else {
        // Fallback si icono no encontrado
        displayText = iconName.slice(0, 4).toUpperCase();
        ctx.font = '14px Arial';
      }
    } else if (buttonData.actions && buttonData.actions.length > 0) {
      // Fallback: mostrar tipo de acción (ej: "RAM" para pc-vitals)
      const firstAction = buttonData.actions[0];
      if (firstAction.type?.includes('pc-vitals')) {
        const comp = firstAction.parameters?.component || 'CPU';
        displayText = comp.toUpperCase();
        ctx.font = '16px Arial';
      } else if (firstAction.type) {
        const short = firstAction.type.split('.').pop() || firstAction.type;
        displayText = short.slice(0, 6).toUpperCase();
        ctx.font = '12px Arial';
      }
    }
    
    // Si aún no hay texto, no dibujar nada (quedará fondo sólido)
    if (displayText) {
      // Ajustar para texto de dos líneas si es muy largo y contiene espacio
      if (displayText.length > 8 && displayText.includes(' ')) {
        const parts = displayText.split(' ');
        const mid = Math.ceil(parts.length / 2);
        const line1 = parts.slice(0, mid).join(' ');
        const line2 = parts.slice(mid).join(' ');
        ctx.font = '12px Arial';
        ctx.fillText(line1, width / 2, height / 2 - 8);
        ctx.fillText(line2, width / 2, height / 2 + 8);
      } else {
        ctx.fillText(displayText, width / 2, height / 2);
      }
    }
    
    // Flip the canvas vertically to correct orientation
    const flippedCanvas = canvasLib.createCanvas(width, height);
    const flippedCtx = flippedCanvas.getContext('2d');
    flippedCtx.scale(1, -1);
    flippedCtx.translate(0, -height);
    flippedCtx.drawImage(canvas, 0, 0);
    
    // Convert to raw RGB buffer for StreamDeck
    return this.canvasToRGBBuffer(flippedCanvas);
  }

  private async tryDrawLucideIcon(ctx: any, iconName: string, width: number, height: number, color: string): Promise<boolean> {
    try {
      // Normalizar nombre: ArrowBigDown -> ArrowBigDown, arrow-big-down -> ArrowBigDown
      // Lucide usa PascalCase en el paquete 'lucide'
      const normalized = iconName.replace(/-/g, '').replace(/^./, (c: string) => c.toUpperCase());
      // También probar con el nombre tal cual
      const candidates = [iconName, normalized, iconName.replace(/Icon$/, ''), normalized.replace(/Icon$/, '')];
      
      let iconData: any = null;
      let foundName = '';
      for (const cand of candidates) {
        try {
          const mod: any = await getLucideModule();
          if (mod[cand]) {
            iconData = mod[cand];
            foundName = cand;
            break;
          }
          // Probar kebab-case a PascalCase
          const pascal = cand.split('-').map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
          if (mod[pascal]) {
            iconData = mod[pascal];
            foundName = pascal;
            break;
          }
        } catch {}
      }
      
      if (!iconData || !Array.isArray(iconData) || iconData.length === 0) {
        return false;
      }

      // iconData es array de [tag, attrs] como [["path", {d: "..."}]]
      // Dibujar centrado y escalado para 72x72 (viewBox 24x24 -> escala 2x)
      const scale = 2.2;
      const offsetX = (width - 24 * scale) / 2;
      const offsetY = (height - 24 * scale) / 2;
      
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (const [tag, attrs] of iconData) {
        if (tag === 'path' && attrs.d) {
          try {
            const path = new (globalThis as any).Path2D(attrs.d);
            if (attrs.fill && attrs.fill !== 'none') {
              ctx.fill(path);
            } else {
              ctx.stroke(path);
            }
          } catch {
            // Fallback: si Path2D no disponible, ignorar
            return false;
          }
        } else if (tag === 'circle' && attrs.cx) {
          ctx.beginPath();
          ctx.arc(Number(attrs.cx), Number(attrs.cy), Number(attrs.r), 0, Math.PI * 2);
          if (attrs.fill && attrs.fill !== 'none') ctx.fill();
          else ctx.stroke();
        } else if (tag === 'rect' && attrs.x !== undefined) {
          if (attrs.fill && attrs.fill !== 'none') {
            ctx.fillRect(Number(attrs.x), Number(attrs.y), Number(attrs.width), Number(attrs.height));
          } else {
            ctx.strokeRect(Number(attrs.x), Number(attrs.y), Number(attrs.width), Number(attrs.height));
          }
        } else if (tag === 'line') {
          ctx.beginPath();
          ctx.moveTo(Number(attrs.x1), Number(attrs.y1));
          ctx.lineTo(Number(attrs.x2), Number(attrs.y2));
          ctx.stroke();
        } else if (tag === 'polyline' && attrs.points) {
          const points = attrs.points.split(' ').map((p: string) => p.split(',').map(Number));
          ctx.beginPath();
          points.forEach(([x, y]: number[], i: number) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
          ctx.stroke();
        } else if (tag === 'polygon' && attrs.points) {
          const points = attrs.points.split(' ').map((p: string) => p.split(',').map(Number));
          ctx.beginPath();
          points.forEach(([x, y]: number[], i: number) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
          ctx.closePath();
          if (attrs.fill && attrs.fill !== 'none') ctx.fill();
          else ctx.stroke();
        }
      }
      ctx.restore();
      return true;
    } catch (e) {
      // console.error('Failed to draw lucide icon', iconName, e);
      return false;
    }
  }

  // Resolver valor dinámico con métricas ya obtenidas (un solo fetch por
  // repintado). Mantiene la firma antigua delegando en la versión con caché.
  private dynamicValueFromMetrics(button: any, metrics: any): string | null {
    try {
      const action = button.data?.actions?.find((a: any) => a.type?.includes('pc-vitals'));
      if (!action) return null;
      const { component = 'cpu', metric = 'usage' } = action.parameters || {};
      if (!metrics) return null;
      let value: number | null = null;
      let unit = '';
      if (component === 'cpu' && metric === 'usage') { value = metrics.cpu?.usage; unit = '%'; }
      else if (component === 'cpu' && metric === 'temperature') { value = metrics.cpu?.temperature; unit = '°C'; }
      else if (component === 'ram' && metric === 'usage') { value = metrics.ram?.usage; unit = '%'; }
      else if (component === 'gpu' && metric === 'usage') { value = metrics.gpu?.usage; unit = '%'; }
      else if (component === 'gpu' && metric === 'temperature') { value = metrics.gpu?.temperature; unit = '°C'; }
      if (value == null || isNaN(value)) return null;
      const rounded = Math.round(value * 10) / 10;
      return `${rounded}${unit}`;
    } catch {
      return null;
    }
  }

  private async fetchSystemMetricsOnce(hasDynamic: boolean): Promise<any | null> {
    if (!hasDynamic) return null;
    try {
      const { API_PORT } = await import('../config');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const res = await fetch(`http://localhost:${API_PORT}/api/v1/system/metrics`, { signal: ctrl.signal });
        if (!res.ok) return null;
        return await res.json();
      } finally {
        clearTimeout(t);
      }
    } catch {
      return null;
    }
  }

  // Resolver valor dinámico para botones con pc-vitals u otros plugins dinámicos
  private async resolveDynamicValue(button: any): Promise<string | null> {
    try {
      const action = button.data?.actions?.find((a: any) => a.type?.includes('pc-vitals'));
      if (!action) return null;
      const metrics = await this.fetchSystemMetricsOnce(true);
      return this.dynamicValueFromMetrics(button, metrics);
    } catch {
      return null;
    }
  }

  private dynamicIntervals = new Map<number, ReturnType<typeof setInterval>>();

  // Repintado diferido y coalescado: los endpoints de botones llaman a esto
  // en vez de `await updateFromPage()` para no bloquear la respuesta HTTP.
  // Múltiples cambios seguidos (vaciar + mover + editar) colapsan en un solo
  // repintado, y si ya hay uno en vuelo se encola otro al terminar.
  private pendingSchedule: { pageId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private updateInFlight = false;
  private queuedPageId: string | null = null;

  scheduleUpdateFromPage(pageId: string, delayMs = 150): void {
    if (!pageId) return;
    if (this.pendingSchedule) clearTimeout(this.pendingSchedule.timer);
    this.pendingSchedule = {
      pageId,
      timer: setTimeout(() => {
        this.pendingSchedule = null;
        this.updateFromPage(pageId).catch((e) =>
          console.error('❌ Scheduled StreamDeck update failed:', e)
        );
      }, delayMs),
    };
  }

  private startDynamicPolling(buttons: any[]) {
    // Limpiar intervalos previos
    for (const [pos, iv] of this.dynamicIntervals.entries()) {
      clearInterval(iv);
    }
    this.dynamicIntervals.clear();

    buttons.forEach((btn, idx) => {
      if (!btn || !btn.data?.actions?.some((a: any) => a.type?.includes('pc-vitals'))) return;
      const action = btn.data.actions.find((a: any) => a.type?.includes('pc-vitals'));
      const intervalMs = action?.parameters?.updateInterval || 1000;
      const pos = btn.position ?? idx;
      const iv = setInterval(async () => {
        try {
          const dyn = await this.resolveDynamicValue(btn);
          if (dyn) {
            const dataWithDyn = { ...btn.data, dynamicValue: dyn };
            const buf = await this.generateButtonImage(dataWithDyn);
            await this.setButtonImage(pos, buf);
          }
        } catch {}
      }, Math.max(500, intervalMs));
      this.dynamicIntervals.set(pos, iv);
    });
  }

  canvasToRGBBuffer(canvas: any): Buffer {
    const width = canvas.width;
    const height = canvas.height;
    
    // Get image data
    const imageData = canvas.getContext('2d').getImageData(0, 0, width, height);
    const data = imageData.data;
    
    // For StreamDeck, we need raw RGB data (no BMP header)
    // StreamDeck expects BGR format, bottom-up
    const buffer = Buffer.alloc(width * height * 3);
    let offset = 0;
    
    for (let y = height - 1; y >= 0; y--) {
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * width + x) * 4;
        const r = data[pixelIndex];
        const g = data[pixelIndex + 1];
        const b = data[pixelIndex + 2];
        
        buffer[offset++] = b; // Blue
        buffer[offset++] = g; // Green
        buffer[offset++] = r; // Red
      }
    }
    
    return buffer;
  }

  async updateButtonStates(buttonStates: boolean[], pageId?: string): Promise<void> {
    if (!this.streamDeck) {
      console.log('❌ StreamDeck not connected, skipping button update');
      return;
    }

    // Legacy boolean path — redirigir a updateFromPage para usar datos reales y valores dinámicos
    console.log('🎛️ updateButtonStates (legacy boolean) recibido, delegando a updateFromPage con datos reales');
    try {
      const db = new DatabaseService();
      // La página explícita (si viene) manda; si no, la guardada en settings
      const rawPageId = pageId ?? db.getSetting('current.page_id');
      const currentPageId = rawPageId && rawPageId !== 'null' && rawPageId !== '' ? rawPageId : null;
      if (currentPageId && currentPageId !== 'null' && currentPageId !== '') {
        const page = db.getPage(currentPageId);
        if (page) {
          await this.updateFromPage(currentPageId);
          return;
        }
      }
      // Fallback: si no hay página, usar lógica anterior pero sin hardcode "Botón"
      console.log('⚠️ No hay página actual, usando fallback por posición');
      const fallbackCount = this.getKeyCount();
      for (let i = 0; i < Math.min(buttonStates.length, fallbackCount); i++) {
        const hasContent = buttonStates[i];
        if (hasContent) {
          const db2 = new DatabaseService();
          const pageId = db2.getSetting('current.page_id');
          const btn = pageId ? db2.getButtonsByPage(pageId).find(b => b.position === i) : null;
          const data = btn?.data || { label: `Btn ${i + 1}`, backgroundColor: '#374151', textColor: '#f1f5f9' };
          const imageBuffer = await this.generateButtonImage(data);
          await this.setButtonImage(i, imageBuffer);
          console.log(`📝 Set button ${i} to TEXT (fallback)`);
        } else {
          await this.setButtonColor(i, 255, 0, 0);
          console.log(`🔴 Set button ${i} to RED (empty)`);
        }
      }
    } catch (error) {
      console.error('❌ Error en updateButtonStates fallback:', error);
    }
  }

  async updateButtonsWithData(buttons: any[]): Promise<void> {
    if (!this.streamDeck) {
      console.log('❌ StreamDeck not connected, skipping button update');
      return;
    }

    console.log(`🎛️ Updating StreamDeck buttons with data for ${buttons.length} buttons`);
    const keyCount = this.getKeyCount();

    try {
      // Un solo fetch de métricas por repintado completo: antes se hacía un
      // fetch (PowerShell ~s) POR CADA tecla dinámica, secuencial, lo que
      // dejaba la API colgada y el HW "eterno" al vaciar/mover teclas.
      const hasDynamic = buttons.some((b) => b?.data?.actions?.some((a: any) => a.type?.includes('pc-vitals')));
      const metrics = await this.fetchSystemMetricsOnce(hasDynamic);
      for (let i = 0; i < Math.min(buttons.length, keyCount); i++) {
        // Ceder el event loop por botón: el render (canvas) + escritura USB
        // son pesados y si no la API/WS se quedan colgados durante el repintado.
        await new Promise<void>((r) => setImmediate(r));
        const button = buttons[i];
        
        if (button && button.data) {
          // Check if button has content
          const hasContent = !!(
            button.data.label?.trim() ||
            button.data.textTop?.trim() ||
            button.data.textBottom?.trim() ||
            button.data.emoji?.trim() ||
            button.data.icon ||
            (button.data.actions && button.data.actions.length > 0)
          );

          if (hasContent) {
            // Si es dinámico (pc-vitals), usar las métricas ya obtenidas
            let dataToRender = button.data;
            if (button.data.actions?.some((a: any) => a.type?.includes('pc-vitals'))) {
              try {
                const dyn = this.dynamicValueFromMetrics(button, metrics);
                if (dyn) dataToRender = { ...button.data, dynamicValue: dyn };
              } catch {}
            }
            const imageBuffer = await this.generateButtonImage(dataToRender);
            await this.setButtonImage(i, imageBuffer);
            console.log(`📝 Set button ${i} to TEXT: "${dataToRender.dynamicValue || dataToRender.label || dataToRender.emoji || 'BTN'}"`);
          } else {
            // Rojo para botones vacíos
            await this.setButtonColor(i, 255, 0, 0);
            console.log(`🔴 Set button ${i} to RED (empty)`);
          }
        } else {
          // Rojo para botones vacíos
          await this.setButtonColor(i, 255, 0, 0);
          console.log(`🔴 Set button ${i} to RED (empty)`);
        }
      }

      console.log('✅ StreamDeck buttons updated with data successfully');
    } catch (error) {
      console.error('❌ Error updating StreamDeck buttons with data:', error);
    }
  }

  async updateFromPage(pageId: string): Promise<void> {
    if (!this.streamDeck) {
      console.log('❌ StreamDeck not connected, skipping page update');
      return;
    }

    // Coalescar repintados concurrentes: si ya hay uno en vuelo (p.ej. un
    // vaciado seguido de un reorder), encolar el último pageId y volver.
    // Evita N repintados completos solapados que eternizaban el HW.
    if (this.updateInFlight) {
      this.queuedPageId = pageId;
      console.log(`⏳ StreamDeck update in flight, queued page: ${pageId}`);
      return;
    }
    this.updateInFlight = true;

    try {
      console.log(`📄 Updating StreamDeck from page: ${pageId}`);

      const db = new DatabaseService();
      const buttons = db.getButtonsByPage(pageId);

      console.log(`📊 Found ${buttons.length} buttons in page ${pageId}`);

      // Create array of buttons in position order
      const buttonsByPosition: any[] = [];
      const maxButtons = this.getKeyCount(); // teclas reales del modelo (6/15/32…)

      for (let i = 0; i < maxButtons; i++) {
        const button = buttons.find(b => b.position === i);
        buttonsByPosition.push(button || null);
        
        if (button && button.data) {
          const hasContent = !!(
            button.data.label?.trim() ||
            button.data.textTop?.trim() ||
            button.data.textBottom?.trim() ||
            button.data.emoji?.trim() ||
            button.data.icon ||
            (button.data.actions && button.data.actions.length > 0)
          );

          console.log(`Button ${i}: exists=${!!button}, hasContent=${hasContent}`, {
            label: button.data.label,
            textTop: button.data.textTop,
            textBottom: button.data.textBottom,
            emoji: button.data.emoji,
            icon: button.data.icon,
            actionsCount: button.data.actions?.length || 0
          });
        } else {
          console.log(`Button ${i}: no button data`);
        }
      }

      console.log('🎛️ Updating buttons with full data');
      await this.updateButtonsWithData(buttonsByPosition);
      // Iniciar polling para valores dinámicos (pc-vitals, etc.)
      this.startDynamicPolling(buttonsByPosition);

    } catch (error) {
      console.error('❌ Error updating StreamDeck from page:', error);
    } finally {
      this.updateInFlight = false;
      // Si durante el repintado llegó otro cambio, repintar una vez más con
      // la página más reciente en vez de haberlo solapado.
      const queued = this.queuedPageId;
      this.queuedPageId = null;
      if (queued) {
        this.updateFromPage(queued).catch((e) =>
          console.error('❌ Queued StreamDeck update failed:', e)
        );
      }
    }
  }

  async updateButtons(buttonStates: boolean[], pageId?: string): Promise<void> {
    console.log('🎛️ Updating StreamDeck buttons with states:', buttonStates);
    await this.updateButtonStates(buttonStates, pageId);
  }

  async handleButtonPress(keyIndex: number): Promise<void> {
    try {
      console.log(`🎛️ StreamDeck button ${keyIndex} pressed - executing actions`);

      // Get current profile and page from database
      const db = new DatabaseService();
      
      // Debug: Check what settings are stored
      const currentProfileId = db.getSetting('current.profile_id');
      const currentPageId = db.getSetting('current.page_id');
      console.log(`🔍 Current settings - profile_id: "${currentProfileId}", page_id: "${currentPageId}"`);
      
      // Log current frontend state (if available via WebSocket or other means)
      // Since we can't directly access frontend state, we'll show what should be current
      const allProfiles = db.getProfiles();
      console.log(`👤 Available profiles: ${allProfiles.length}`, allProfiles.map(p => ({ id: p.id, name: p.name })));
      
      // Try to determine what the "current" profile should be
      let expectedProfileId = currentProfileId;
      if (expectedProfileId === 'null' || expectedProfileId === null || expectedProfileId === '') {
        // If invalid, use the first available profile
        if (allProfiles.length > 0) {
          expectedProfileId = allProfiles[0].id;
          console.log(`⚠️ Invalid profile_id in settings, using first available profile: ${expectedProfileId}`);
        }
      }
      
      console.log(`📍 Expected current profile: ${expectedProfileId}`);
      
      // If we need to update settings, do it now
      if (expectedProfileId !== currentProfileId) {
        console.log(`🔧 Auto-correcting invalid profile_id setting to: ${expectedProfileId}`);
        db.setSetting('current.profile_id', expectedProfileId);
      }
      
      // Now try to get the profile with the corrected ID
      const currentProfile = expectedProfileId ? db.getProfile(expectedProfileId) : null;
      console.log(`🔍 Current profile lookup result:`, currentProfile ? `Found profile ${currentProfile.id} (${currentProfile.name})` : 'No profile found');
      
      if (!currentProfile) {
        console.log('❌ No current profile found for StreamDeck button press');
        // List all available profiles for debugging
        console.log(`📋 Available profiles in database: ${allProfiles.length}`, allProfiles.map(p => ({ id: p.id, name: p.name })));
        return;
      }

      // Log current page state
      const allPages = db.getPagesByProfile(currentProfile.id);
      console.log(`📄 Available pages for current profile: ${allPages.length}`, allPages.map(p => ({ id: p.id, name: p.name, is_folder: p.is_folder })));
      
      // Try to determine what the "current" page should be
      let expectedPageId = currentPageId;
      if (expectedPageId === 'null' || expectedPageId === null || expectedPageId === '') {
        // If invalid, use the first non-folder page
        const nonFolderPages = allPages.filter(p => p.is_folder === 0);
        if (nonFolderPages.length > 0) {
          expectedPageId = nonFolderPages[0].id;
          console.log(`⚠️ Invalid page_id in settings, using first non-folder page: ${expectedPageId}`);
        }
      }
      
      console.log(`📍 Expected current page: ${expectedPageId}`);
      
      // If we need to update settings, do it now
      if (expectedPageId !== currentPageId) {
        console.log(`🔧 Auto-correcting invalid page_id setting to: ${expectedPageId}`);
        db.setSetting('current.page_id', expectedPageId);
      }
      
      // Now try to get the page with the corrected ID
      const currentPage = expectedPageId ? db.getPage(expectedPageId) : null;
      // Verify the page belongs to the current profile
      const validCurrentPage = currentPage && currentPage.profile_id === currentProfile.id ? currentPage : null;
      console.log(`🔍 Current page lookup result:`, validCurrentPage ? `Found page ${validCurrentPage.id} (${validCurrentPage.name})` : 'No page found');
      
      if (!validCurrentPage) {
        console.log('❌ No current page found for StreamDeck button press');
        // List all pages for the current profile
        console.log(`📄 Available pages for profile ${currentProfile.id}: ${allPages.length}`, allPages.map(p => ({ id: p.id, name: p.name, is_folder: p.is_folder })));
        return;
      }

      // Find button at the specified position
      const button = db.getButtonsByPage(validCurrentPage.id).find(b => b.position === keyIndex);
      console.log(`🔍 Button lookup at position ${keyIndex}:`, button ? `Found button ${button.id}` : 'No button found');
      
      if (!button) {
        console.log(`❌ No button found at position ${keyIndex}`);
        // List all buttons for debugging
        const allButtons = db.getButtonsByPage(validCurrentPage.id);
        console.log(`🔘 All buttons in page ${validCurrentPage.id}: ${allButtons.length}`, allButtons.map(b => ({ id: b.id, position: b.position, hasData: !!b.data })));
        return;
      }

      if (!button.data?.actions || button.data.actions.length === 0) {
        console.log(`⚠️ Button at position ${keyIndex} has no actions to execute`);
        return;
      }

      console.log(`🔘 Executing ${button.data.actions.length} actions for button at position ${keyIndex}`);

      // Execute each action using the existing API endpoint
      for (const action of button.data.actions) {
        try {
          console.log(`▶️ Executing action: ${action.type}`);

          const { API_PORT } = await import('../config');
          const response = await fetch(`http://localhost:${API_PORT}/api/v1/actions/execute`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              action,
              context: {
                buttonId: button.id,
                pageId: validCurrentPage.id,
                profileId: currentProfile.id,
                position: keyIndex,
                source: 'streamdeck'
              }
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Failed to execute action ${action.type}: ${response.status} ${errorText}`);
          } else {
            const result = await response.json();
            console.log(`✅ Action executed successfully: ${action.type}`, result);
          }
        } catch (error) {
          console.error(`❌ Error executing action ${action.type}:`, error);
        }
      }

      console.log(`✅ Finished executing actions for StreamDeck button ${keyIndex}`);
    } catch (error) {
      console.error(`❌ Error handling StreamDeck button press ${keyIndex}:`, error);
    }
  }
}

// Singleton instance
export const streamDeckDriver = new StreamDeckDriver();