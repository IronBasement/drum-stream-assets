import { SerialPort } from 'serialport';
import WebSocketCoordinatorServer from '../WebSocketCoordinatorServer';
import { midiNoteDefinitions, midiNoteKeysByName } from '../../../shared/midiNoteDefinitions';
import { createLogger } from '../../../shared/util';

const log = createLogger('DMXLighting');

// DMX512 Configuration
const DMX_PORT = 'COM3';
const DMX_BAUD_RATE = 250000;
const DMX_UNIVERSE_SIZE = 512;
const DEVICE_CHANNELS = 121;
const NUM_LIGHTS = 40;

interface DrumMapping {
  name: string;
  midiKeys: number[];
  color: { r: number; g: number; b: number };
}

interface DrumFlash {
  drumName: string;
  color: { r: number; g: number; b: number };
  intensity: number;
  age: number;
}

export default class DMXLightingModule {
  private port!: SerialPort; // Will be initialized in initializeDMX
  private dmxData: Uint8Array;
  private isConnected: boolean = false;
  private transmissionInterval: NodeJS.Timeout | null = null;
  private updateInterval: NodeJS.Timeout | null = null;
  private activeFlashes: DrumFlash[] = [];

  // Define drum-to-color mappings (dim colors so they can add together without becoming white)
  private drumMappings: DrumMapping[] = [
    {
      name: 'Kick',
      midiKeys: midiNoteKeysByName.Kick,
      color: this.parseColor('rgb(50, 50, 50)') // Neutral gray for kick
    },
    {
      name: 'Tom4',
      midiKeys: midiNoteKeysByName.Tom4,
      color: this.parseColor('rgb(0, 60, 0)') // Green
    },
    {
      name: 'Tom3',
      midiKeys: midiNoteKeysByName.Tom3,
      color: this.parseColor('rgb(0, 60, 30)') // Cyan-green
    },
    {
      name: 'Tom2',
      midiKeys: midiNoteKeysByName.Tom2,
      color: this.parseColor('rgb(0, 30, 60)') // Sky blue
    },
    {
      name: 'Tom1',
      midiKeys: midiNoteKeysByName.Tom1,
      color: this.parseColor('rgb(0, 0, 60)') // Blue
    },
    {
      name: 'Snare',
      midiKeys: midiNoteKeysByName.Snare,
      color: this.parseColor('rgb(60, 0, 0)') // Red
    },
    {
      name: 'HiHat',
      midiKeys: midiNoteKeysByName.HiHat,
      color: this.parseColor('rgb(50, 45, 15)') // Golden yellow
    },
    {
      name: 'Crash1',
      midiKeys: midiNoteKeysByName.Crash1,
      color: this.parseColor('rgb(60, 60, 0)') // Yellow
    },
    {
      name: 'Crash2',
      midiKeys: midiNoteKeysByName.Crash2,
      color: this.parseColor('rgb(60, 0, 60)') // Magenta
    },
    {
      name: 'Crash3',
      midiKeys: midiNoteKeysByName.Crash3,
      color: this.parseColor('rgb(30, 60, 60)') // Light cyan
    },
    {
      name: 'Ride',
      midiKeys: midiNoteKeysByName.Ride,
      color: this.parseColor('rgb(60, 30, 0)') // Orange
    },
    {
      name: 'Ride2',
      midiKeys: midiNoteKeysByName.Ride2,
      color: this.parseColor('rgb(45, 20, 0)') // Dark orange
    },
    {
      name: 'Splash',
      midiKeys: midiNoteKeysByName.Splash,
      color: this.parseColor('rgb(30, 0, 60)') // Purple
    },
    {
      name: 'Splash2',
      midiKeys: midiNoteKeysByName.Splash2,
      color: this.parseColor('rgb(0, 30, 30)') // Dark cyan
    }
  ];

    constructor(private webSocketCoordinatorServer: WebSocketCoordinatorServer) {
    this.dmxData = new Uint8Array(DMX_UNIVERSE_SIZE);
    this.initializeDMX();
    this.setupMIDIListeners();
    this.startFlashEngine();
  }

  private parseColor(colorString: string): { r: number; g: number; b: number } {
    // Handle hex colors
    if (colorString.startsWith('#')) {
      const hex = colorString.slice(1);
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16)
      };
    }

    // Handle rgb() colors
    const rgbMatch = colorString.match(/rgb\((\d+)[,\s]+(\d+)[,\s]+(\d+)\)/);
    if (rgbMatch) {
      return {
        r: parseInt(rgbMatch[1]),
        g: parseInt(rgbMatch[2]),
        b: parseInt(rgbMatch[3])
      };
    }

    // Default to white if parsing fails
    log('Could not parse color:', colorString);
    return { r: 255, g: 255, b: 255 };
  }

  private async initializeDMX(): Promise<void> {
    try {
      log('Initializing DMX controller on', DMX_PORT);

      this.port = new SerialPort({
        path: DMX_PORT,
        baudRate: DMX_BAUD_RATE,
        dataBits: 8,
        stopBits: 2,
        parity: 'none'
      });

      this.port.on('open', () => {
        log('✅ Connected to DMX device');
        this.isConnected = true;
        this.startDMXTransmission();
      });

      this.port.on('error', (err) => {
        log('❌ DMX port error:', err.message);
        this.isConnected = false;
      });

      this.port.on('close', () => {
        log('📴 DMX port closed');
        this.isConnected = false;
      });

    } catch (error) {
      log('❌ Failed to initialize DMX:', error);
    }
  }

  private startDMXTransmission(): void {
    this.transmissionInterval = setInterval(() => {
      if (this.isConnected) {
        this.sendDMXFrame();
      }
    }, 40); // 25Hz refresh rate
  }

  private sendDMXFrame(): void {
    try {
      this.port.set({brk: true}, () => {
        setTimeout(() => {
          this.port.set({brk: false}, () => {
            setTimeout(() => {
              const frame = Buffer.alloc(DEVICE_CHANNELS + 1);
              frame[0] = 0x00; // Start code

              for (let i = 0; i < DEVICE_CHANNELS; i++) {
                frame[i + 1] = this.dmxData[i];
              }

              this.port.write(frame, (error) => {
                if (error) {
                  log('Write error:', error.message);
                }
              });
            }, 0.1);
          });
        }, 0.2);
      });
    } catch (error) {
      log('Send frame error:', error);
    }
  }

  private setupMIDIListeners(): void {
    this.webSocketCoordinatorServer.registerHandler('midi_note_on', (data: any) => {
      this.handleMIDINoteOn(data.note, data.velocity);
    });
  }

  private startFlashEngine(): void {
    // Update flashes at 60fps for smooth animation
    this.updateInterval = setInterval(() => {
      this.updateFlashes();
      this.renderLights();
    }, 16); // ~60fps
  }

  private updateFlashes(): void {
    // Update all active flashes
    for (let i = this.activeFlashes.length - 1; i >= 0; i--) {
      const flash = this.activeFlashes[i];

      flash.age += 16; // Age in milliseconds

      // Fast fade out
      const fadeTime = 400; // 400ms fade (pretty quick)
      flash.intensity = Math.max(0, 1 - (flash.age / fadeTime));

      // Remove dead flashes
      if (flash.intensity <= 0) {
        this.activeFlashes.splice(i, 1);
      }
    }
  }

  private renderLights(): void {
    // Set master dimmer to full
    this.setMasterDimmer(255);

    // Calculate combined color from all active flashes
    let combinedR = 0;
    let combinedG = 0;
    let combinedB = 0;

    for (const flash of this.activeFlashes) {
      // Add this flash's color contribution (with intensity applied)
      combinedR += flash.color.r * flash.intensity;
      combinedG += flash.color.g * flash.intensity;
      combinedB += flash.color.b * flash.intensity;
    }

    // Clamp colors to valid range
    combinedR = Math.min(255, Math.floor(combinedR));
    combinedG = Math.min(255, Math.floor(combinedG));
    combinedB = Math.min(255, Math.floor(combinedB));

    // Set all lights to the same combined color
    for (let i = 1; i <= NUM_LIGHTS; i++) {
      this.setLightRGB(i, combinedR, combinedG, combinedB);
    }
  }

  private handleMIDINoteOn(note: number, velocity: number): void {
    // Find which drum this note belongs to
    const drumMapping = this.drumMappings.find(mapping =>
      mapping.midiKeys.includes(note)
    );

    if (!drumMapping) {
      return; // Not a drum we're interested in
    }

    this.createFlash(drumMapping, velocity);
  }

  private createFlash(drumMapping: DrumMapping, velocity: number): void {
    // Calculate intensity based on velocity (0-127 MIDI range)
    const baseIntensity = velocity / 127;

    // Create flash that affects all lights
    const flash: DrumFlash = {
      drumName: drumMapping.name,
      color: {
        r: drumMapping.color.r,
        g: drumMapping.color.g,
        b: drumMapping.color.b
      },
      intensity: baseIntensity,
      age: 0
    };

    this.activeFlashes.push(flash);
  }





  private setMasterDimmer(intensity: number): void {
    this.dmxData[0] = Math.max(0, Math.min(255, Math.floor(intensity)));
  }

  private setLightRGB(lightNumber: number, r: number, g: number, b: number): void {
    if (lightNumber < 1 || lightNumber > NUM_LIGHTS) {
      return;
    }

    // Channel 1 = master dimmer
    // Channels 2-4 = Light 1 RGB, etc.
    const baseChannel = 1 + (lightNumber - 1) * 3;

    this.dmxData[baseChannel] = Math.max(0, Math.min(255, Math.floor(r)));
    this.dmxData[baseChannel + 1] = Math.max(0, Math.min(255, Math.floor(g)));
    this.dmxData[baseChannel + 2] = Math.max(0, Math.min(255, Math.floor(b)));
  }

  public turnOffAllLights(): void {
    // Clear all active flashes
    this.activeFlashes = [];
    this.setMasterDimmer(255); // Keep master at full
  }

  public close(): void {
    log('Closing DMX connection...');

    // Stop flash engine
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Clear all active flashes
    this.activeFlashes = [];

    if (this.transmissionInterval) {
      clearInterval(this.transmissionInterval);
      this.transmissionInterval = null;
    }

    this.turnOffAllLights();

    if (this.port?.isOpen) {
      this.port.close();
    }
  }
}
