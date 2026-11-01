/** Video sources: a webcam, or a recorded clip (`?source=file&src=...`) for testing without a camera. */
import type { Resolution } from '../app/settings';
import { t } from '../i18n';

export interface CameraInfo {
  id: string;
  label: string;
}

export async function listCameras(): Promise<CameraInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ id: d.deviceId, label: d.label || t('stage.cameraN', { n: i + 1 }) }));
}

export class VideoSource {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  kind: 'none' | 'camera' | 'file' = 'none';
  label = '';

  constructor(video: HTMLVideoElement) {
    this.video = video;
    video.muted = true;
    video.playsInline = true;
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this.kind = 'none';
  }

  async openCamera(deviceId: string | null, res: Resolution, fps: number): Promise<string> {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('stage.noGetUserMedia'));
    const [w, h] = res.split('x').map(Number);
    const open = (id: string | null) =>
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: id ? { exact: id } : undefined,
          width: { ideal: w },
          height: { ideal: h },
          frameRate: { ideal: Math.max(30, fps) },
        },
      });
    let stream: MediaStream;
    try {
      stream = await open(deviceId);
    } catch (e) {
      // WebKit salts device IDs per origin, so an ID saved by another build
      // (dev server vs. the bundled app) or for an unplugged camera matches
      // nothing. Fall back to the default camera instead of failing.
      const name = (e as DOMException).name;
      if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw e;
      stream = await open(null);
    }
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play();
    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    this.kind = 'camera';
    this.label = track.label;
    return `${s.width}x${s.height}@${Math.round(s.frameRate ?? 0)}`;
  }

  async openFile(url: string, loop = true): Promise<string> {
    this.stop();
    this.video.src = url;
    this.video.loop = loop;
    await new Promise<void>((resolve, reject) => {
      this.video.onloadeddata = () => resolve();
      this.video.onerror = () => reject(new Error(`cannot load video ${url}`));
    });
    await this.video.play();
    this.kind = 'file';
    this.label = url.split('/').pop() ?? url;
    return `${this.video.videoWidth}x${this.video.videoHeight} FILE`;
  }
}
