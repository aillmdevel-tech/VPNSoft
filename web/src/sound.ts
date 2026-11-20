// Tiny synthesized sound kit (WebAudio, no files: the CSP blocks fetch and keeps the bundle small).
type Name = "pop" | "tap" | "splash" | "boom" | "whoosh" | "thunder" | "wind" | "erupt" | "chime" | "stamp" | "click" | "snow" | "whale";
const KEY = "route.sound";

class Sound {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  enabled = localStorage.getItem(KEY) !== "off";
  private noise: AudioBuffer | null = null;
  private last: Record<string, number> = {};
  constructor() {
    const unlock = () => { this.init(); this.ctx?.resume(); };
    addEventListener("pointerdown", unlock, { capture: true, passive: true });
    addEventListener("keydown", unlock, { capture: true });
  }
  private init() {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain(); this.master.gain.value = .5; this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 1.5, buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
  }
  setEnabled(on: boolean) { this.enabled = on; try { localStorage.setItem(KEY, on ? "on" : "off"); } catch {} }
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
    const c = this.ctx!, t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + .008); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    o.connect(g).connect(this.master!); o.start(t); o.stop(t + dur + .02);
  }
  private hiss(filter: BiquadFilterType, f0: number, f1: number, dur: number, vol: number, delay = 0, q = 1) {
    const c = this.ctx!, t = c.currentTime + delay, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; f.type = filter; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    s.connect(f).connect(g).connect(this.master!); s.start(t, Math.random()); s.stop(t + dur + .05);
  }
  play(name: Name) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx || this.ctx.state !== "running") return;
    const now = performance.now();
    if (now - (this.last[name] || 0) < 60) return;
    this.last[name] = now;
    switch (name) {
      case "tap": this.tone("sine", 520, 380, .09, .18); break;
      case "click": this.tone("triangle", 880, 640, .06, .12); break;
      case "pop": this.tone("sine", 300, 900, .12, .25); this.tone("sine", 900, 1300, .08, .08, .05); break;
      case "splash": this.hiss("bandpass", 1800, 500, .45, .35, 0, .8); this.tone("sine", 260, 120, .2, .12); break;
      case "whoosh": this.hiss("bandpass", 300, 2400, .7, .25, 0, 1.4); break;
      case "boom": this.tone("sine", 120, 32, .9, .7); this.hiss("lowpass", 1400, 90, 1.1, .6); this.tone("square", 70, 30, .3, .08); break;
      case "thunder": this.hiss("lowpass", 900, 60, 1.6, .55); this.tone("sine", 80, 30, 1.2, .3, .05); break;
      case "wind": this.hiss("bandpass", 500, 900, 2.2, .18, 0, 3); break;
      case "erupt": this.tone("sawtooth", 90, 40, .8, .12); this.hiss("lowpass", 700, 120, 1.2, .45); break;
      case "chime": [0, .09, .18].forEach((d, i) => this.tone("sine", [784, 988, 1319][i], [784, 988, 1319][i] * 1.01, .5, .16, d)); break;
      case "stamp": this.tone("square", 140, 60, .12, .2); this.hiss("lowpass", 2000, 300, .15, .3); break;
      case "snow": this.tone("sine", 1500, 1700, .25, .05); this.tone("sine", 2100, 2300, .25, .04, .08); break;
      case "whale": this.tone("sine", 180, 420, .9, .1); this.tone("sine", 420, 220, .7, .08, .7); break;
    }
  }
}

export const sound = new Sound();
export type SoundName = Name;
