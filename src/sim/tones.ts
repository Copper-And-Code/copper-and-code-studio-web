// The Buzzer of a game prints tone markers; here they become sound, as upstream's
// ui/sim_audio.py on the desktop and runtime/web/lms_web.js in the browser do: a square wave.
const GAIN = 0.08;

export class TonePlayer {
  private audio: AudioContext | null = null;
  private oscillator: OscillatorNode | null = null;
  private stopAt: ReturnType<typeof setTimeout> | undefined;
  count = 0;

  /** Browsers allow sound only after a user gesture: call this from the click that starts. */
  prepare(): void {
    try {
      this.audio ??= new AudioContext();
      void this.audio.resume();
    } catch {
      this.audio = null; // no Web Audio: the game runs without sound
    }
  }

  play(frequency: number, milliseconds: number): void {
    this.count++;
    clearTimeout(this.stopAt);
    this.oscillator?.stop();
    this.oscillator = null;
    if (!this.audio || frequency <= 0) return;
    const oscillator = this.audio.createOscillator();
    const gain = this.audio.createGain();
    oscillator.type = 'square';
    oscillator.frequency.value = frequency;
    gain.gain.value = GAIN;
    oscillator.connect(gain).connect(this.audio.destination);
    oscillator.start();
    this.oscillator = oscillator;
    if (milliseconds > 0) this.stopAt = setTimeout(() => this.play(0, 0), milliseconds);
  }

  stop(): void {
    clearTimeout(this.stopAt);
    this.oscillator?.stop();
    this.oscillator = null;
  }
}

/** sim/session.py TONE_LINE: "\x1bLVSIM_TONE <frequency> <milliseconds>" and the end of line. */
// eslint-disable-next-line no-control-regex -- the marker starts with ESC, as upstream's
const TONE_LINE = /\x1bLVSIM_TONE (\d+) (\d+)\r?\n/g;
const TONE_PREFIX = '\x1bLVSIM_TONE';

/** Takes the tone markers out of the output, keeping a marker cut in two for the next piece. */
export class ToneFilter {
  private tail = '';

  constructor(private readonly tone: (frequency: number, milliseconds: number) => void) {}

  feed(chunk: string): string {
    let text = this.tail + chunk;
    this.tail = '';
    text = text.replace(TONE_LINE, (_line, frequency: string, milliseconds: string) => {
      this.tone(Number(frequency), Number(milliseconds));
      return '';
    });
    const partial = text.lastIndexOf('\x1b');
    if (partial >= 0 && TONE_PREFIX.startsWith(text.slice(partial, partial + TONE_PREFIX.length))) {
      const rest = text.slice(partial);
      if (!rest.includes('\n') && rest.length < 64) {
        this.tail = rest;
        text = text.slice(0, partial);
      }
    }
    return text;
  }
}
