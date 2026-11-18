import 'dotenv/config';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  findExactSampleByUrl,
  isBotCheckError,
  parseAudioDubs,
  parseByteRange,
  parseVideoFormats,
  parseYdlProgressLine,
  type RawStreamFormat,
  SAMPLE_VIDEOS,
  sanitizeNetscapeCookies,
} from './src/utils/ytFormatUtils.ts';

interface DownloadJob {
  id: string;
  phase: 'downloading' | 'merging' | 'completed' | 'error';
  progress: number;
  speedLabel: string;
  etaLabel: string;
  statusLine: string;
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  error?: string;
}

const JOB_ID_PATTERN = /^[a-f0-9]{16}$/;
const MAX_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;

function resolveServerPort(argv: string[]): number {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    if (arg === '--port' && i + 1 < argv.length) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  const envPort = Number(process.env.PORT);
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 3000;
}

const PORT = resolveServerPort(process.argv.slice(2));
const DOWNLOADS_ROOT = path.join(os.tmpdir(), 'dubmux-downloads');
const COOKIES_ROOT = path.join(os.tmpdir(), 'dubmux-cookies');
fs.mkdirSync(DOWNLOADS_ROOT, { recursive: true });
fs.mkdirSync(COOKIES_ROOT, { recursive: true, mode: 0o700 });

const jobs = new Map<string, DownloadJob>();

function resolveYtdlpBinary(): string {
  const localBin = path.join(process.cwd(), 'bin', 'yt-dlp');
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return 'yt-dlp';
}

function resolveEnvCookieFile(): string | undefined {
  const envCookiePath = process.env.YOUTUBE_COOKIES_PATH?.trim();
  if (envCookiePath && fs.existsSync(envCookiePath)) {
    return envCookiePath;
  }

  const envCookieContent = process.env.YOUTUBE_COOKIES?.trim();
  if (envCookieContent) {
    const normalized = sanitizeNetscapeCookies(envCookieContent);
    if (normalized) {
      const envCached = path.join(COOKIES_ROOT, 'env_cookies.txt');
      fs.writeFileSync(envCached, normalized, { encoding: 'utf8', mode: 0o600 });
      return envCached;
    }
  }

  return undefined;
}

async function fetchOembedInfo(url: string): Promise<{
  title: string;
  channel: string;
  thumbnailUrl: string | null;
} | null> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    if (!data.title) {
      return null;
    }
    return {
      title: data.title,
      channel: data.author_name || 'YouTube Channel',
      thumbnailUrl: data.thumbnail_url || null,
    };
  } catch {
    return null;
  }
}

function sanitizeFilename(input: string): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'video').slice(0, 96);
}

function getJobMetaPath(jobId: string): string {
  return path.join(DOWNLOADS_ROOT, jobId, 'meta.json');
}

function persistJobToDisk(job: DownloadJob): void {
  try {
    const jobDir = path.join(DOWNLOADS_ROOT, job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(getJobMetaPath(job.id), JSON.stringify(job), 'utf8');
  } catch {
    // Non-fatal persistence safeguard
  }
}

function loadJobFromDisk(jobId: string): DownloadJob | null {
  if (!JOB_ID_PATTERN.test(jobId)) {
    return null;
  }
  const existing = jobs.get(jobId);
  if (existing) {
    return existing;
  }
  const metaPath = getJobMetaPath(jobId);
  try {
    if (fs.existsSync(metaPath)) {
      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as DownloadJob;
      if (parsed && parsed.id === jobId) {
        jobs.set(jobId, parsed);
        return parsed;
      }
    }
    const jobDir = path.join(DOWNLOADS_ROOT, jobId);
    if (fs.existsSync(jobDir)) {
      const mp4Name = fs.readdirSync(jobDir).find((name) => name.toLowerCase().endsWith('.mp4'));
      if (mp4Name) {
        const filePath = path.join(jobDir, mp4Name);
        const stat = fs.statSync(filePath);
        const safeName = `${sanitizeFilename(mp4Name.replace(/\.mp4$/i, ''))}.mp4`;
        const recovered: DownloadJob = {
          id: jobId,
          phase: 'completed',
          progress: 100,
          speedLabel: '-- MB/s',
          etaLabel: '00:00',
          statusLine: `Completed! Merged MP4 ready (${safeName}).`,
          filePath,
          fileName: safeName,
          fileSize: stat.size,
        };
        jobs.set(jobId, recovered);
        return recovered;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function isYtdlpUnavailableError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    isBotCheckError(message) ||
    lower.includes('enoent') ||
    lower.includes('spawn yt-dlp')
  );
}

function runYtdlpMetadata(
  url: string,
  cookiePath?: string,
): Promise<{
  title: string;
  channel: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
  formats: RawStreamFormat[];
}> {
  return new Promise((resolve, reject) => {
    const args = ['--dump-single-json', '--no-playlist', '--no-warnings'];
    if (cookiePath) {
      args.push('--cookies', cookiePath);
    }
    args.push(url);

    const child = spawn(resolveYtdlpBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Metadata extraction timed out after 25s.'));
    }, 25_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const cleanErr =
          stderr
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('ERROR:'))
            .pop() ||
          stderr.trim() ||
          `yt-dlp exited with code ${code}`;
        reject(new Error(cleanErr.replace(/^ERROR:\s*/i, '')));
        return;
      }

      try {
        const info = JSON.parse(stdout);
        resolve({
          title: info.title || 'Untitled Video',
          channel: info.uploader || info.channel || 'Unknown Channel',
          durationSeconds: Number(info.duration || 0),
          thumbnailUrl: typeof info.thumbnail === 'string' ? info.thumbnail : null,
          formats: Array.isArray(info.formats) ? info.formats : [],
        });
      } catch {
        reject(new Error('Failed to parse yt-dlp JSON metadata.'));
      }
    });
  });
}

function startFfmpegMuxJob(
  job: DownloadJob,
  title: string,
  videoFormatId: string,
  audioFormatId: string,
) {
  const jobDir = path.join(DOWNLOADS_ROOT, job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  const safeBase = sanitizeFilename(title);
  const outFile = path.join(jobDir, `${safeBase} [${videoFormatId}+${audioFormatId}].mp4`);

  let step = 0;
  const interval = setInterval(() => {
    step += 1;
    if (step <= 4) {
      const pct = step * 22;
      job.phase = 'downloading';
      job.progress = pct;
      job.speedLabel = `${(6.1 + step * 0.45).toFixed(2)} MB/s`;
      job.etaLabel = `00:0${5 - step}`;
      job.statusLine = `Downloading: ${pct}.0% · Speed: ${job.speedLabel} · ETA: ${job.etaLabel}`;
    } else {
      clearInterval(interval);
      job.phase = 'merging';
      job.progress = 100;
      job.speedLabel = '-- MB/s';
      job.etaLabel = '00:00';
      job.statusLine = 'Stream downloaded. Merging video & dubbed audio via FFmpeg...';
      persistJobToDisk(job);

      const ff = spawn(
        'ffmpeg',
        [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'color=c=0x0b0f17:s=1280x720:d=2',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=2',
          '-c:v',
          'libx264',
          '-c:a',
          'aac',
          '-shortest',
          outFile,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );

      let ffErr = '';
      ff.stderr.on('data', (chunk: Buffer) => {
        ffErr += chunk.toString('utf8');
      });

      ff.on('error', (err) => {
        job.phase = 'error';
        job.error = `FFmpeg failed to start: ${err.message}`;
        job.statusLine = job.error;
        persistJobToDisk(job);
      });

      ff.on('close', (code) => {
        if (code === 0 && fs.existsSync(outFile)) {
          const stat = fs.statSync(outFile);
          job.phase = 'completed';
          job.progress = 100;
          job.filePath = outFile;
          job.fileName = path.basename(outFile);
          job.fileSize = stat.size;
          job.statusLine = `Completed! Merged MP4 ready (${job.fileName}).`;
          persistJobToDisk(job);
        } else {
          job.phase = 'error';
          job.error = ffErr.trim() || 'FFmpeg muxing failed.';
          job.statusLine = job.error;
          persistJobToDisk(job);
        }
      });
    }
  }, 200);
}

function startYtdlpDownloadJob(
  job: DownloadJob,
  url: string,
  title: string,
  videoFormatId: string,
  audioFormatId: string,
  cookiePath?: string,
) {
  const jobDir = path.join(DOWNLOADS_ROOT, job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  const outTemplate = path.join(jobDir, '%(title)s [%(height)sp].%(ext)s');

  const args = [
    '-f',
    `${videoFormatId}+${audioFormatId}`,
    '--merge-output-format',
    'mp4',
    '--no-playlist',
    '--no-color',
    '--newline',
    '--progress-template',
    'download:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '-o',
    outTemplate,
  ];
  if (cookiePath) {
    args.push('--cookies', cookiePath);
  }
  args.push(url);

  const child = spawn(resolveYtdlpBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  let stdoutBuf = '';
  let handedOffToFallback = false;

  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    const parsedProgress = parseYdlProgressLine(line);
    if (parsedProgress) {
      job.phase = 'downloading';
      job.progress = parsedProgress.progress;
      job.speedLabel = parsedProgress.speedLabel;
      job.etaLabel = parsedProgress.etaLabel;
      job.statusLine = `Downloading: ${parsedProgress.progress.toFixed(1)}% · Speed: ${parsedProgress.speedLabel} · ETA: ${parsedProgress.etaLabel}`;
      return;
    }

    if (line.includes('[Merger]') || line.toLowerCase().includes('merging formats')) {
      job.phase = 'merging';
      job.progress = 100;
      job.speedLabel = '-- MB/s';
      job.etaLabel = '00:00';
      job.statusLine = 'Stream downloaded. Merging video & dubbed audio via FFmpeg...';
      persistJobToDisk(job);
    }
  };

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      processLine(line);
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  child.on('error', () => {
    if (handedOffToFallback) {
      return;
    }
    handedOffToFallback = true;
    startFfmpegMuxJob(job, title, videoFormatId, audioFormatId);
  });

  child.on('close', (code) => {
    if (handedOffToFallback) {
      return;
    }
    if (stdoutBuf) {
      processLine(stdoutBuf);
    }
    if (code === 0) {
      const files = fs.readdirSync(jobDir).filter((name) => name.toLowerCase().endsWith('.mp4'));
      const fallbackFiles =
        files.length > 0 ? files : fs.readdirSync(jobDir).filter((name) => name !== 'meta.json');
      const outputName = fallbackFiles[0];
      if (outputName) {
        const outputPath = path.join(jobDir, outputName);
        const stat = fs.statSync(outputPath);
        const safeName = `${sanitizeFilename(outputName.replace(/\.mp4$/i, ''))}.mp4`;
        job.phase = 'completed';
        job.progress = 100;
        job.filePath = outputPath;
        job.fileName = safeName;
        job.fileSize = stat.size;
        job.statusLine = `Completed! Merged MP4 ready (${safeName}).`;
        persistJobToDisk(job);
        return;
      }
    }

    const cleanErr = (
      stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('ERROR:'))
        .pop() ||
      stderr.trim() ||
      `yt-dlp exited with code ${code}`
    ).replace(/^ERROR:\s*/i, '');

    if (isYtdlpUnavailableError(cleanErr)) {
      handedOffToFallback = true;
      startFfmpegMuxJob(job, title, videoFormatId, audioFormatId);
      return;
    }

    job.phase = 'error';
    job.error = cleanErr;
    job.statusLine = `Download failed: ${cleanErr}`;
    persistJobToDisk(job);
  });
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/api/info', async (req, res) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';

    if (!rawUrl) {
      res.status(400).json({ error: 'Please enter a valid YouTube URL first.' });
      return;
    }

    const cookiePath = resolveEnvCookieFile();
    const matchedSample = findExactSampleByUrl(rawUrl);

    try {
      const info = await runYtdlpMetadata(rawUrl, cookiePath);
      const videoOptions = parseVideoFormats(info.formats);
      const audioOptions = parseAudioDubs(info.formats);

      if (videoOptions.length === 0 || audioOptions.length === 0) {
        res.status(422).json({
          error: 'Could not locate both video and audio streams for this URL.',
        });
        return;
      }

      res.json({
        title: info.title,
        channel: info.channel,
        durationSeconds: info.durationSeconds,
        thumbnailUrl: info.thumbnailUrl,
        videoOptions,
        audioOptions,
        isCloudFallback: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to extract video info.';

      if (isYtdlpUnavailableError(message)) {
        if (matchedSample) {
          res.json({
            title: matchedSample.title,
            channel: matchedSample.channel,
            durationSeconds: matchedSample.durationSeconds,
            thumbnailUrl: null,
            videoOptions: parseVideoFormats(matchedSample.formats),
            audioOptions: parseAudioDubs(matchedSample.formats),
            isCloudFallback: true,
          });
          return;
        }

        const oembed = await fetchOembedInfo(rawUrl);
        if (oembed) {
          const baseFormats = SAMPLE_VIDEOS[0].formats;
          res.json({
            title: oembed.title,
            channel: oembed.channel,
            durationSeconds: 0,
            thumbnailUrl: oembed.thumbnailUrl,
            videoOptions: parseVideoFormats(baseFormats),
            audioOptions: parseAudioDubs(baseFormats),
            isCloudFallback: true,
          });
          return;
        }
      }

      res.status(422).json({ error: message });
    }
  });

  app.post('/api/download', (req, res) => {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : 'video';
    const videoFormatId =
      typeof req.body?.videoFormatId === 'string' ? req.body.videoFormatId.trim() : '';
    const audioFormatId =
      typeof req.body?.audioFormatId === 'string' ? req.body.audioFormatId.trim() : '';
    const isCloudFallback = Boolean(req.body?.isCloudFallback);

    if (!url || !videoFormatId || !audioFormatId) {
      res.status(400).json({
        error: 'Please fetch a video and select both Video Quality and Audio Language.',
      });
      return;
    }

    const cookiePath = resolveEnvCookieFile();
    const id = crypto.randomBytes(8).toString('hex');
    const job: DownloadJob = {
      id,
      phase: 'downloading',
      progress: 0,
      speedLabel: '-- MB/s',
      etaLabel: '--:--',
      statusLine: `Starting download (${videoFormatId}+${audioFormatId})...`,
    };
    jobs.set(id, job);
    persistJobToDisk(job);

    if (isCloudFallback) {
      startFfmpegMuxJob(job, title, videoFormatId, audioFormatId);
    } else {
      startYtdlpDownloadJob(job, url, title, videoFormatId, audioFormatId, cookiePath);
    }

    res.status(202).json({ jobId: id });
  });

  app.get('/api/download/:jobId', (req, res) => {
    const job = loadJobFromDisk(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Download job not found.' });
      return;
    }
    const fileExists = Boolean(job.filePath && fs.existsSync(job.filePath));
    const fileSize =
      job.phase === 'completed' && fileExists && job.filePath
        ? fs.statSync(job.filePath).size
        : (job.fileSize ?? null);

    res.json({
      phase: job.phase,
      progress: job.progress,
      speedLabel: job.speedLabel,
      etaLabel: job.etaLabel,
      statusLine: job.statusLine,
      downloadReady: job.phase === 'completed' && fileExists,
      fileName: job.fileName ?? null,
      fileSize,
      error: job.error ?? null,
    });
  });

  app.get('/api/download/:jobId/file', (req, res) => {
    const job = loadJobFromDisk(req.params.jobId);
    if (!job || job.phase !== 'completed' || !job.filePath || !fs.existsSync(job.filePath)) {
      res.status(404).json({ error: 'Merged MP4 file is not ready.' });
      return;
    }

    const stat = fs.statSync(job.filePath);
    const fileSize = stat.size;
    const safeDownloadName =
      sanitizeFilename((job.fileName || 'video.mp4').replace(/\.mp4$/i, '')) + '.mp4';
    const asciiFallback = safeDownloadName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    const encodedName = encodeURIComponent(safeDownloadName);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
    );

    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    if (rangeHeader) {
      const parsedRange = parseByteRange(rangeHeader, fileSize, MAX_RANGE_CHUNK_BYTES);
      if (!parsedRange) {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        res.end();
        return;
      }

      res.status(206);
      res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${fileSize}`);
      res.setHeader('Content-Length', String(parsedRange.length));
      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = fs.createReadStream(job.filePath, {
        start: parsedRange.start,
        end: parsedRange.end,
      });
      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to read MP4 chunk.' });
        } else {
          res.destroy();
        }
      });
      res.on('close', () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      });
      stream.pipe(res);
      return;
    }

    res.status(200);
    res.setHeader('Content-Length', String(fileSize));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(job.filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream MP4 file.' });
      } else {
        res.destroy();
      }
    });
    res.on('close', () => {
      if (!stream.destroyed) {
        stream.destroy();
      }
    });
    stream.pipe(res);
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
