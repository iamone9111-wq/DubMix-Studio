import { useEffect, useRef, useState } from 'react';
import { Download, Film, FolderOpen, Languages, Search } from 'lucide-react';
import { formatDuration, ParsedStreamOption, SAMPLE_VIDEOS } from '../utils/ytFormatUtils';

type AppPhase = 'idle' | 'fetching' | 'ready' | 'downloading' | 'merging' | 'completed' | 'error';

const STUDIO_THUMBNAIL = '/src/assets/images/dubmix_studio_thumbnail_1794883955957.jpg';

interface InfoApiResponse {
  title?: string;
  channel?: string;
  durationSeconds?: number;
  thumbnailUrl?: string | null;
  videoOptions?: ParsedStreamOption[];
  audioOptions?: ParsedStreamOption[];
  isCloudFallback?: boolean;
  error?: string;
}

interface JobStatusResponse {
  phase: 'downloading' | 'merging' | 'completed' | 'error';
  progress: number;
  speedLabel: string;
  etaLabel: string;
  statusLine: string;
  downloadReady: boolean;
  fileName: string | null;
  error: string | null;
}

export function DesktopSimulator() {
  const [urlInput, setUrlInput] = useState(SAMPLE_VIDEOS[0].url);
  const [phase, setPhase] = useState<AppPhase>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [videoTitle, setVideoTitle] = useState('DubMix Studio');
  const [videoMeta, setVideoMeta] = useState(
    'Paste a YouTube link and click Fetch Video Info to choose resolution and dubbed audio.',
  );
  const [thumbnailUrl, setThumbnailUrl] = useState<string>(STUDIO_THUMBNAIL);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [videoOptions, setVideoOptions] = useState<ParsedStreamOption[]>([]);
  const [audioOptions, setAudioOptions] = useState<ParsedStreamOption[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState('');
  const [selectedAudioId, setSelectedAudioId] = useState('');
  const [isCloudFallback, setIsCloudFallback] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusLine, setStatusLine] = useState('Ready');
  const [speedLabel, setSpeedLabel] = useState('-- MB/s');
  const [etaLabel, setEtaLabel] = useState('--:--');
  const [completedFileUrl, setCompletedFileUrl] = useState<string | null>(null);
  const [completedFileName, setCompletedFileName] = useState<string | null>(null);

  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const triggerBrowserDownload = async (fileUrl: string, fileName: string) => {
    try {
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error('Download endpoint returned an error.');
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      setCompletedFileUrl(blobUrl);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = fileName;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      const anchor = document.createElement('a');
      anchor.href = fileUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }
  };

  const handleFetchInfo = async () => {
    stopPolling();
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setPhase('error');
      setErrorMessage('Please enter a valid YouTube URL first.');
      setStatusLine('Please enter a valid YouTube URL first.');
      return;
    }

    setErrorMessage('');
    if (completedFileUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(completedFileUrl);
    }
    setCompletedFileUrl(null);
    setCompletedFileName(null);
    setPhase('fetching');
    setProgress(0);
    setSpeedLabel('-- MB/s');
    setEtaLabel('--:--');
    setStatusLine('Fetching video info and audio dub tracks...');

    try {
      const response = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = (await response.json()) as InfoApiResponse;

      if (!response.ok) {
        setPhase('error');
        setVideoOptions([]);
        setAudioOptions([]);
        setSelectedVideoId('');
        setSelectedAudioId('');
        setThumbnailUrl(STUDIO_THUMBNAIL);
        setThumbnailFailed(false);
        setErrorMessage(data.error || 'Failed to fetch video info.');
        setStatusLine(data.error || 'Failed to fetch video info.');
        return;
      }

      const videos = data.videoOptions ?? [];
      const audios = data.audioOptions ?? [];
      const durationPart =
        data.durationSeconds && data.durationSeconds > 0
          ? ` · Duration: ${formatDuration(data.durationSeconds)}`
          : '';

      setVideoTitle(data.title || 'DubMix Studio');
      setVideoMeta(
        `${data.channel || 'YouTube'}${durationPart} · ${videos.length} video qualities, ${audios.length} audio tracks`,
      );
      setThumbnailFailed(false);
      setThumbnailUrl(data.thumbnailUrl || STUDIO_THUMBNAIL);
      setVideoOptions(videos);
      setAudioOptions(audios);
      setSelectedVideoId(videos[0]?.formatId ?? '');
      setSelectedAudioId(audios[0]?.formatId ?? '');
      setIsCloudFallback(Boolean(data.isCloudFallback));
      setPhase('ready');
      setStatusLine(
        'Ready to download. Select Video Quality and Audio Language, then click Download & Merge MP4.',
      );
    } catch {
      setPhase('error');
      setErrorMessage('Unable to reach backend service.');
      setStatusLine('Unable to reach backend service.');
    }
  };

  const handleDownload = async () => {
    if (!selectedVideoId || !selectedAudioId || phase === 'downloading' || phase === 'merging') {
      return;
    }
    stopPolling();
    setErrorMessage('');
    if (completedFileUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(completedFileUrl);
    }
    setCompletedFileUrl(null);
    setCompletedFileName(null);
    setPhase('downloading');
    setProgress(0);
    setSpeedLabel('-- MB/s');
    setEtaLabel('--:--');
    setStatusLine(`Starting download (${selectedVideoId}+${selectedAudioId})...`);

    try {
      const startRes = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: urlInput.trim(),
          title: videoTitle,
          videoFormatId: selectedVideoId,
          audioFormatId: selectedAudioId,
          isCloudFallback,
        }),
      });
      const startData = (await startRes.json()) as { jobId?: string; error?: string };

      if (!startRes.ok || !startData.jobId) {
        setPhase('error');
        setErrorMessage(startData.error || 'Failed to start download.');
        setStatusLine(startData.error || 'Failed to start download.');
        return;
      }

      const jobId = startData.jobId;
      pollTimerRef.current = window.setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/download/${jobId}`);
          const job = (await statusRes.json()) as JobStatusResponse;
          if (!statusRes.ok) {
            stopPolling();
            setPhase('error');
            setErrorMessage('Lost track of download progress.');
            return;
          }

          setProgress(job.progress);
          setSpeedLabel(job.speedLabel);
          setEtaLabel(job.etaLabel);
          setStatusLine(job.statusLine);

          if (job.phase === 'completed') {
            stopPolling();
            setPhase('completed');
            const fileUrl = `/api/download/${jobId}/file`;
            const fileName = job.fileName || 'video.mp4';
            setCompletedFileUrl(fileUrl);
            setCompletedFileName(fileName);
            await triggerBrowserDownload(fileUrl, fileName);
          } else if (job.phase === 'error') {
            stopPolling();
            setPhase('error');
            setErrorMessage(job.error || job.statusLine);
          } else {
            setPhase(job.phase);
          }
        } catch {
          stopPolling();
          setPhase('error');
          setErrorMessage('Connection interrupted while checking download progress.');
        }
      }, 220);
    } catch {
      setPhase('error');
      setErrorMessage('Unable to start download.');
      setStatusLine('Unable to start download.');
    }
  };

  const isBusy = phase === 'fetching' || phase === 'downloading' || phase === 'merging';

  return (
    <section
      aria-label="DubMix Studio"
      className="w-full max-w-2xl rounded-xl border border-slate-800 bg-[#111827] p-6 sm:p-7"
    >
      <div className="mb-6 border-b border-slate-800 pb-4">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">DubMix Studio</h1>
        <p className="mt-1 text-sm text-slate-400">
          YouTube multi-audio downloader &amp; FFmpeg MP4 muxer
        </p>
        <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
          <span>Presets:</span>
          {SAMPLE_VIDEOS.map((sample, index) => (
            <button
              key={sample.id}
              type="button"
              disabled={isBusy}
              onClick={() => {
                setUrlInput(sample.url);
              }}
              className="rounded-md border border-slate-700 bg-slate-800/80 px-2.5 py-1 font-medium text-slate-200 transition-colors hover:border-sky-500/60 hover:text-white disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              Sample {index + 1}
            </button>
          ))}
        </div>
      </div>

      {/* URL Entry + Fetch Video Info */}
      <div className="space-y-2">
        <label htmlFor="yt-url-input" className="block text-xs font-medium text-slate-300">
          YouTube Video URL
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="yt-url-input"
            type="url"
            value={urlInput}
            disabled={isBusy}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void handleFetchInfo();
              }
            }}
            placeholder="https://www.youtube.com/watch?v=..."
            className="h-11 w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-60 sm:flex-1"
          />
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleFetchInfo()}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-sky-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            <span>{phase === 'fetching' ? 'Fetching...' : 'Fetch Video Info'}</span>
          </button>
        </div>
      </div>

      {/* Thumbnail + Extracted Video Info Summary */}
      <div className="mt-5 flex flex-col gap-4 border-y border-slate-800/80 py-4 sm:flex-row sm:items-center">
        <div className="aspect-video w-full overflow-hidden rounded-lg bg-[#0B0F17] sm:w-44 shrink-0">
          {!thumbnailFailed ? (
            <img
              src={thumbnailUrl}
              alt={`${videoTitle} thumbnail`}
              referrerPolicy="no-referrer"
              onError={() => {
                if (thumbnailUrl !== STUDIO_THUMBNAIL) {
                  setThumbnailUrl(STUDIO_THUMBNAIL);
                } else {
                  setThumbnailFailed(true);
                }
              }}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 text-xs font-medium text-slate-300">
              DubMix Studio
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-100 line-clamp-2">{videoTitle}</p>
          <p className="mt-1 text-xs text-slate-400">{videoMeta}</p>
        </div>
      </div>

      {/* Video Quality & Audio Language Comboboxes */}
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor="video-quality-select"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-300"
          >
            <Film className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            <span>Video Quality</span>
          </label>
          <select
            id="video-quality-select"
            value={selectedVideoId}
            disabled={videoOptions.length === 0 || isBusy}
            onChange={(e) => setSelectedVideoId(e.target.value)}
            className="h-11 w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {videoOptions.length === 0 ? (
              <option value="">Fetch a video first...</option>
            ) : (
              videoOptions.map((opt) => (
                <option key={opt.formatId} value={opt.formatId}>
                  {opt.label}
                </option>
              ))
            )}
          </select>
        </div>

        <div>
          <label
            htmlFor="audio-language-select"
            className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-300"
          >
            <Languages className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            <span>Audio Language (Original &amp; Dubs)</span>
          </label>
          <select
            id="audio-language-select"
            value={selectedAudioId}
            disabled={audioOptions.length === 0 || isBusy}
            onChange={(e) => setSelectedAudioId(e.target.value)}
            className="h-11 w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {audioOptions.length === 0 ? (
              <option value="">Fetch a video first...</option>
            ) : (
              audioOptions.map((opt) => (
                <option key={opt.formatId} value={opt.formatId}>
                  {opt.label}
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      {/* Output Directory Summary */}
      <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
        <span className="flex items-center gap-1.5 truncate">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
          <span className="truncate">Save to: ~/Downloads</span>
        </span>
        <span className="font-mono text-slate-500">MP4 Container (FFmpeg)</span>
      </div>

      {/* Progress Bar & Status Label */}
      <div className="mt-5 space-y-2.5">
        <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-300">
          <span>{progress}%</span>
          <span>
            Speed: {speedLabel} · ETA: {etaLabel}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="h-3 w-full overflow-hidden rounded-full bg-slate-800"
        >
          <div
            className={`h-full transition-all duration-150 ${
              phase === 'completed'
                ? 'bg-emerald-500'
                : phase === 'error'
                  ? 'bg-rose-500'
                  : 'bg-sky-500'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p
            role="status"
            className={`text-xs ${
              phase === 'error'
                ? 'text-rose-400'
                : phase === 'completed'
                  ? 'text-emerald-400'
                  : 'text-slate-300'
            }`}
          >
            {errorMessage || statusLine}
          </p>
          {completedFileUrl && completedFileName && (
            <a
              href={completedFileUrl}
              download={completedFileName}
              className="text-xs font-medium text-sky-400 underline-offset-4 hover:underline whitespace-nowrap shrink-0"
            >
              Save MP4 again
            </a>
          )}
        </div>
      </div>

      {/* Primary Download CTA */}
      <div className="mt-6">
        <button
          type="button"
          disabled={!selectedVideoId || !selectedAudioId || isBusy}
          onClick={() => void handleDownload()}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          <span>
            {phase === 'downloading'
              ? 'Downloading Streams...'
              : phase === 'merging'
                ? 'Merging via FFmpeg...'
                : 'Download & Merge MP4'}
          </span>
        </button>
      </div>
    </section>
  );
}
