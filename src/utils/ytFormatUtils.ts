export interface RawStreamFormat {
  format_id: string;
  vcodec?: string | null;
  acodec?: string | null;
  height?: number | null;
  fps?: number | null;
  ext?: string | null;
  tbr?: number | null;
  vbr?: number | null;
  abr?: number | null;
  language?: string | null;
  language_preference?: number | null;
  format_note?: string | null;
}

export interface ParsedStreamOption {
  formatId: string;
  label: string;
  meta: string;
}

export interface SampleVideoPayload {
  id: string;
  url: string;
  title: string;
  channel: string;
  durationSeconds: number;
  formats: RawStreamFormat[];
}

const LANGUAGE_NAMES: Record<string, string> = {
  ar: 'Arabic',
  bn: 'Bengali',
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  gu: 'Gujarati',
  hi: 'Hindi',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  kn: 'Kannada',
  ko: 'Korean',
  ml: 'Malayalam',
  mr: 'Marathi',
  nl: 'Dutch',
  pa: 'Punjabi',
  pl: 'Polish',
  pt: 'Portuguese',
  ru: 'Russian',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
  zh: 'Chinese',
};

export function resolveLanguageName(langCode?: string | null): string {
  if (!langCode) {
    return 'Original';
  }
  const normalized = langCode.trim();
  const base = normalized.split(/[-_]/)[0].toLowerCase();
  const friendly = LANGUAGE_NAMES[base];
  return friendly ? `${friendly} (${normalized})` : normalized.toUpperCase();
}

export function parseVideoFormats(formats: RawStreamFormat[]): ParsedStreamOption[] {
  const bestByBucket = new Map<
    string,
    { score: number; height: number; fps: number; option: ParsedStreamOption }
  >();

  for (const fmt of formats) {
    if (!fmt.format_id || !fmt.vcodec || fmt.vcodec === 'none' || !fmt.height) {
      continue;
    }
    const height = Math.round(fmt.height);
    const fps = Math.round(fmt.fps ?? 30);
    const isVideoOnly = !fmt.acodec || fmt.acodec === 'none' ? 1 : 0;
    const ext = fmt.ext || 'mp4';
    const isMp4 = ext === 'mp4' ? 1 : 0;
    const tbr = fmt.tbr ?? fmt.vbr ?? 0;
    const score = isVideoOnly * 1_000_000 + isMp4 * 100_000 + tbr;

    const bucketKey = `${height}-${fps}`;
    const resTag =
      height >= 2160 ? `${height}p (4K)` : height === 1440 ? `${height}p (2K)` : `${height}p`;
    const fpsTag = fps > 30 ? ` ${fps}fps` : '';
    const codecShort = fmt.vcodec.split('.')[0];

    const existing = bestByBucket.get(bucketKey);
    if (!existing || score > existing.score) {
      bestByBucket.set(bucketKey, {
        score,
        height,
        fps,
        option: {
          formatId: fmt.format_id,
          label: `${resTag}${fpsTag} · ${ext.toUpperCase()} (${codecShort})`,
          meta: `${Math.round(tbr)} kbps`,
        },
      });
    }
  }

  return Array.from(bestByBucket.values())
    .sort((a, b) => b.height - a.height || b.fps - a.fps)
    .map((entry) => entry.option);
}

export function parseAudioDubs(formats: RawStreamFormat[]): ParsedStreamOption[] {
  const bestByTrack = new Map<
    string,
    { score: number; isOriginal: boolean; option: ParsedStreamOption }
  >();

  for (const fmt of formats) {
    if (!fmt.format_id || !fmt.acodec || fmt.acodec === 'none') {
      continue;
    }
    const isAudioOnly = !fmt.vcodec || fmt.vcodec === 'none' ? 1 : 0;
    const lang = fmt.language ?? null;
    const noteLower = (fmt.format_note ?? '').toLowerCase();
    const isOriginal =
      noteLower.includes('original') ||
      (typeof fmt.language_preference === 'number' && fmt.language_preference >= 10) ||
      lang === null;

    const trackKey = `${(lang ?? 'original').toLowerCase()}-${isOriginal ? 'orig' : 'dub'}`;
    const ext = fmt.ext || 'm4a';
    const isM4a = ext === 'm4a' ? 1 : 0;
    const abr = fmt.abr ?? fmt.tbr ?? 0;
    const score = isAudioOnly * 1_000_000 + isM4a * 100_000 + abr;

    let readable = lang ? resolveLanguageName(lang) : 'Original (Default)';
    if (lang && isOriginal) {
      readable = `${readable} · Original`;
    } else if (lang && noteLower.includes('dub')) {
      readable = `${readable} · Dubbed`;
    }
    const abrTag = abr > 0 ? ` · ${Math.round(abr)}kbps` : '';

    const existing = bestByTrack.get(trackKey);
    if (!existing || score > existing.score) {
      bestByTrack.set(trackKey, {
        score,
        isOriginal,
        option: {
          formatId: fmt.format_id,
          label: `${readable}${abrTag} [${ext}]`,
          meta: fmt.acodec,
        },
      });
    }
  }

  return Array.from(bestByTrack.values())
    .sort((a, b) => {
      if (a.isOriginal !== b.isOriginal) {
        return a.isOriginal ? -1 : 1;
      }
      return a.option.label.localeCompare(b.option.label);
    })
    .map((entry) => entry.option);
}

export function buildYdlMergeOptions(videoFormatId: string, audioFormatId: string) {
  return {
    format: `${videoFormatId}+${audioFormatId}`,
    merge_output_format: 'mp4',
  };
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatSpeedBps(speedBps?: number | null): string {
  if (!speedBps || !Number.isFinite(speedBps) || speedBps <= 0) {
    return '-- MB/s';
  }
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let val = speedBps;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(2)} ${units[idx]}`;
}

export function formatEtaSeconds(etaSeconds?: number | null): string {
  if (etaSeconds === undefined || etaSeconds === null || !Number.isFinite(etaSeconds) || etaSeconds < 0) {
    return '--:--';
  }
  return formatDuration(etaSeconds);
}

export interface ParsedProgressLine {
  progress: number;
  speedLabel: string;
  etaLabel: string;
}

export function parseYdlProgressLine(line: string): ParsedProgressLine | null {
  if (!line.startsWith('download:')) {
    return null;
  }
  const parts = line.slice('download:'.length).trim().split('|');
  if (parts.length < 5) {
    return null;
  }
  const downloaded = Number.parseFloat(parts[0]);
  const total = Number.parseFloat(parts[1]) || Number.parseFloat(parts[2]);
  const speed = Number.parseFloat(parts[3]);
  const eta = Number.parseFloat(parts[4]);

  const progress =
    Number.isFinite(downloaded) && Number.isFinite(total) && total > 0
      ? Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)))
      : 0;

  return {
    progress,
    speedLabel: formatSpeedBps(Number.isFinite(speed) ? speed : null),
    etaLabel: formatEtaSeconds(Number.isFinite(eta) ? eta : null),
  };
}

export const SAMPLE_VIDEOS: SampleVideoPayload[] = [
  {
    id: 'mrbeast-dubbed',
    url: 'https://www.youtube.com/watch?v=0e3GPea1Tyg',
    title: '$456,000 Squid Game In Real Life! (Multi-Audio Dubbed)',
    channel: 'MrBeast',
    durationSeconds: 1542,
    formats: [
      { format_id: '313', vcodec: 'vp9', acodec: 'none', height: 2160, fps: 30, ext: 'webm', tbr: 16800 },
      { format_id: '299', vcodec: 'avc1.64002a', acodec: 'none', height: 1080, fps: 60, ext: 'mp4', tbr: 6200 },
      { format_id: '137', vcodec: 'avc1.640028', acodec: 'none', height: 1080, fps: 30, ext: 'mp4', tbr: 4100 },
      { format_id: '136', vcodec: 'avc1.4d401f', acodec: 'none', height: 720, fps: 30, ext: 'mp4', tbr: 2150 },
      { format_id: '135', vcodec: 'avc1.4d401e', acodec: 'none', height: 480, fps: 30, ext: 'mp4', tbr: 1050 },
      { format_id: '140-en', vcodec: 'none', acodec: 'mp4a.40.2', language: 'en', language_preference: 10, format_note: 'English original', ext: 'm4a', abr: 128 },
      { format_id: '140-hi', vcodec: 'none', acodec: 'mp4a.40.2', language: 'hi', language_preference: -1, format_note: 'Hindi (dubbed)', ext: 'm4a', abr: 128 },
      { format_id: '140-bn', vcodec: 'none', acodec: 'mp4a.40.2', language: 'bn', language_preference: -1, format_note: 'Bengali (dubbed)', ext: 'm4a', abr: 128 },
      { format_id: '140-fr', vcodec: 'none', acodec: 'mp4a.40.2', language: 'fr', language_preference: -1, format_note: 'French (dubbed)', ext: 'm4a', abr: 128 },
      { format_id: '140-es', vcodec: 'none', acodec: 'mp4a.40.2', language: 'es', language_preference: -1, format_note: 'Spanish (dubbed)', ext: 'm4a', abr: 128 },
      { format_id: '140-ja', vcodec: 'none', acodec: 'mp4a.40.2', language: 'ja', language_preference: -1, format_note: 'Japanese (dubbed)', ext: 'm4a', abr: 128 },
    ],
  },
  {
    id: 'science-documentary',
    url: 'https://www.youtube.com/watch?v=aircAruvnKk',
    title: 'How Deep Neural Networks Learn — Multilingual Edition',
    channel: '3Blue1Brown',
    durationSeconds: 1153,
    formats: [
      { format_id: '401', vcodec: 'av01.0.12M.08', acodec: 'none', height: 2160, fps: 60, ext: 'mp4', tbr: 14200 },
      { format_id: '299', vcodec: 'avc1.64002a', acodec: 'none', height: 1080, fps: 60, ext: 'mp4', tbr: 5400 },
      { format_id: '136', vcodec: 'avc1.4d401f', acodec: 'none', height: 720, fps: 30, ext: 'mp4', tbr: 1850 },
      { format_id: '140-en', vcodec: 'none', acodec: 'mp4a.40.2', language: 'en', language_preference: 10, format_note: 'English original', ext: 'm4a', abr: 128 },
      { format_id: '140-hi', vcodec: 'none', acodec: 'mp4a.40.2', language: 'hi', language_preference: -1, format_note: 'Hindi (dubbed)', ext: 'm4a', abr: 128 },
      { format_id: '140-de', vcodec: 'none', acodec: 'mp4a.40.2', language: 'de', language_preference: -1, format_note: 'German (dubbed)', ext: 'm4a', abr: 128 },
      { format_id: '140-es', vcodec: 'none', acodec: 'mp4a.40.2', language: 'es', language_preference: -1, format_note: 'Spanish (dubbed)', ext: 'm4a', abr: 128 },
    ],
  },
];

export function findExactSampleByUrl(url: string): SampleVideoPayload | undefined {
  const normalized = url.trim().toLowerCase();
  return SAMPLE_VIDEOS.find((item) => item.url.toLowerCase() === normalized);
}

export function isBotCheckError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('confirm you’re not a bot') ||
    lower.includes("confirm you're not a bot") ||
    lower.includes('use --cookies-from-browser or --cookies')
  );
}

export function sanitizeNetscapeCookies(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const hasCookieRow = lines.some((line) => !line.startsWith('#') && line.split('\t').length >= 6);
  if (!hasCookieRow) {
    return null;
  }
  if (!lines[0].startsWith('# Netscape HTTP Cookie File')) {
    lines.unshift('# Netscape HTTP Cookie File');
  }
  return `${lines.join('\n')}\n`;
}

export interface ByteRange {
  start: number;
  end: number;
  length: number;
}

export function parseByteRange(
  rangeHeader: string | undefined,
  fileSize: number,
  maxChunkBytes = 8 * 1024 * 1024,
): ByteRange | null {
  if (!rangeHeader || fileSize <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }
  const [, startStr, endStr] = match;
  if (!startStr && !endStr) {
    return null;
  }

  let start: number;
  let end: number;

  if (startStr && endStr) {
    start = Number.parseInt(startStr, 10);
    end = Math.min(Number.parseInt(endStr, 10), fileSize - 1);
  } else if (startStr) {
    start = Number.parseInt(startStr, 10);
    end = Math.min(start + maxChunkBytes - 1, fileSize - 1);
  } else {
    const suffix = Number.parseInt(endStr, 10);
    if (suffix <= 0) {
      return null;
    }
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || end >= fileSize) {
    return null;
  }

  return {
    start,
    end,
    length: end - start + 1,
  };
}

export function formatBytesSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}
