import * as RNFS from '@dr.pogodin/react-native-fs';

/** Matches WavSegmentWriter: 16 kHz mono PCM16 with a 44-byte header. */
export const WAV_RATE = 16000;
const HEADER_BYTES = 44;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    s +=
      B64[(n >> 18) & 63] +
      B64[(n >> 12) & 63] +
      (b === undefined ? '=' : B64[(n >> 6) & 63]) +
      (c === undefined ? '=' : B64[n & 63]);
  }
  return s;
}

export function wavHeaderBase64(dataBytes: number): string {
  const h: number[] = [];
  const str = (x: string) => {
    for (let i = 0; i < x.length; i++) h.push(x.charCodeAt(i));
  };
  const u32 = (v: number) => h.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const u16 = (v: number) => h.push(v & 255, (v >> 8) & 255);
  str('RIFF');
  u32(36 + dataBytes);
  str('WAVE');
  str('fmt ');
  u32(16);
  u16(1);
  u16(1);
  u32(WAV_RATE);
  u32(WAV_RATE * 2);
  u16(2);
  u16(16);
  str('data');
  u32(dataBytes);
  return toBase64(h);
}

/** Copies [fromMs, toMs) of a segment WAV into a new WAV file. */
export async function writeWavSlice(src: string, fromMs: number, toMs: number, dst: string) {
  const first = Math.max(0, Math.round((fromMs * WAV_RATE) / 1000));
  const last = Math.max(first, Math.round((toMs * WAV_RATE) / 1000));
  const bytes = (last - first) * 2;
  const data = await RNFS.read(src, bytes, HEADER_BYTES + first * 2, 'base64');
  await RNFS.writeFile(dst, wavHeaderBase64(bytes), 'base64');
  await RNFS.appendFile(dst, data, 'base64');
}
