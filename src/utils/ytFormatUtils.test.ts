import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYdlMergeOptions,
  formatBytesSize,
  formatDuration,
  isBotCheckError,
  parseAudioDubs,
  parseByteRange,
  parseVideoFormats,
  parseYdlProgressLine,
  SAMPLE_VIDEOS,
  sanitizeNetscapeCookies,
} from './ytFormatUtils';

test('parseVideoFormats sorts resolutions descending and picks best mp4 stream per bucket', () => {
  const parsed = parseVideoFormats(SAMPLE_VIDEOS[0].formats);
  assert.equal(parsed[0].formatId, '313');
  assert.equal(parsed[1].formatId, '299');
  assert.equal(parsed[2].formatId, '137');
  assert.ok(parsed[0].label.includes('2160p (4K)'));
});

test('parseAudioDubs keeps Original track first and exposes multi-language dubs', () => {
  const parsed = parseAudioDubs(SAMPLE_VIDEOS[0].formats);
  assert.equal(parsed[0].formatId, '140-en');
  assert.ok(parsed[0].label.includes('Original'));
  const formatIds = parsed.map((p) => p.formatId);
  assert.ok(formatIds.includes('140-hi'));
  assert.ok(formatIds.includes('140-fr'));
  assert.ok(formatIds.includes('140-bn'));
  assert.ok(formatIds.includes('140-es'));
});

test('buildYdlMergeOptions generates exact yt-dlp merge config', () => {
  const opts = buildYdlMergeOptions('299', '140-hi');
  assert.deepEqual(opts, {
    format: '299+140-hi',
    merge_output_format: 'mp4',
  });
});

test('formatDuration formats MM:SS cleanly', () => {
  assert.equal(formatDuration(125), '02:05');
  assert.equal(formatDuration(3661), '01:01:01');
});

test('parseYdlProgressLine extracts percentage, speed, and ETA from yt-dlp progress template', () => {
  const parsed = parseYdlProgressLine('download:5242880|10485760|NA|2621440|12');
  assert.deepEqual(parsed, {
    progress: 50,
    speedLabel: '2.50 MB/s',
    etaLabel: '00:12',
  });
  assert.equal(parseYdlProgressLine('[Merger] Merging formats into "out.mp4"'), null);
});

test('isBotCheckError detects YouTube bot verification messages', () => {
  assert.equal(
    isBotCheckError("[youtube] TjPPIf-M6KE: Sign in to confirm you're not a bot."),
    true,
  );
  assert.equal(isBotCheckError('[youtube] TjPPlf-M6KE: This video is unavailable'), false);
});

test('sanitizeNetscapeCookies validates tab-delimited Netscape cookie rows', () => {
  const valid = '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tVISITOR_INFO1_LIVE\tabc123';
  const normalized = sanitizeNetscapeCookies(valid);
  assert.ok(normalized?.startsWith('# Netscape HTTP Cookie File\n'));
  assert.equal(sanitizeNetscapeCookies('not a cookie file'), null);
});

test('parseByteRange parses explicit, open-ended, and invalid ranges accurately', () => {
  assert.deepEqual(parseByteRange('bytes=0-1023', 5000), {
    start: 0,
    end: 1023,
    length: 1024,
  });
  assert.deepEqual(parseByteRange('bytes=4000-9999', 5000), {
    start: 4000,
    end: 4999,
    length: 1000,
  });
  assert.equal(parseByteRange('bytes=6000-7000', 5000), null);
  assert.equal(formatBytesSize(15 * 1024 * 1024), '15.0 MB');
});
