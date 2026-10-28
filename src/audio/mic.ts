/** Microphone capture for lip sync: getUserMedia -> AnalyserNode -> mouth shapes. */
import { analyzeSpectrum, dbToMag, DEFAULT_ANALYSIS, MouthSmoother, rmsDb, silentShapes, type AnalysisOptions, type MouthShapes } from './visemes';

export interface MicDevice {
  id: string;
  label: string;
}

export async function listMics(): Promise<MicDevice[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, label: (d.label || `MICROPHONE ${i + 1}`).toUpperCase() }));
  } catch {
    return [];
  }
}

export class MicInput {
  opts: AnalysisOptions = { ...DEFAULT_ANALYSIS };
  readonly smoother = new MouthSmoother();
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private time = new Float32Array(2048);
  private freq = new Float32Array(1024);
  private mag = new Float32Array(1024);
  /** Last raw (unsmoothed) analysis, for the meter. */
  raw: MouthShapes = silentShapes();
  label = '';

  get running(): boolean {
    return !!this.analyser;
  }

  async start(deviceId: string | null): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
      },
      video: false,
    });
    await this.startStream(stream);
  }

  /** Use an existing stream (tests feed a generated one). */
  async startStream(stream: MediaStream): Promise<void> {
    this.stop();
    this.stream = stream;
    this.label = stream.getAudioTracks()[0]?.label ?? '';
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0;
    src.connect(an);
    this.ctx = ctx;
    this.analyser = an;
    this.time = new Float32Array(an.fftSize);
    this.freq = new Float32Array(an.frequencyBinCount);
    this.mag = new Float32Array(an.frequencyBinCount);
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.raw = silentShapes();
  }

  /** Analyse the latest audio and advance the smoother. */
  read(dt: number): MouthShapes {
    const an = this.analyser;
    if (!an || !this.ctx) return this.smoother.update(silentShapes(), dt);
    an.getFloatTimeDomainData(this.time);
    an.getFloatFrequencyData(this.freq);
    dbToMag(this.freq, this.mag);
    this.raw = analyzeSpectrum(this.mag, this.ctx.sampleRate, rmsDb(this.time), this.opts);
    return this.smoother.update(this.raw, dt);
  }
}
