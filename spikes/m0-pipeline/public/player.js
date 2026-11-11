// Diagnostic player for the M0 spike. Engine selection mirrors the planned
// client player: native HLS where the platform provides it (Safari, iOS
// WKWebView), hls.js (MSE / ManagedMediaSource) everywhere else.
const params = new URLSearchParams(location.search);
const video = /** @type {HTMLVideoElement} */ (document.getElementById('video'));
const logEl = /** @type {HTMLElement} */ (document.getElementById('log'));
const qualityEl = /** @type {HTMLSelectElement} */ (document.getElementById('quality'));

const state = { engine: '', sessionId: '', errors: /** @type {string[]} */ ([]) };
// Exposed for automated browser tests.
Object.assign(window, { __player: state });

function log(msg) {
  logEl.textContent += `${new Date().toISOString().slice(11, 23)} ${msg}\n`;
}

function chooseEngine() {
  const forced = params.get('engine');
  if (forced === 'native' || forced === 'hlsjs') return forced;
  const native = video.canPlayType('application/vnd.apple.mpegurl') !== '';
  const isApple = /Apple/.test(navigator.vendor);
  return native && isApple ? 'native' : 'hlsjs';
}

function detectCapabilities() {
  const hevc =
    video.canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"') !== '' ||
    ('MediaSource' in window &&
      MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"'));
  return {
    hevc,
    maxHeight:
      Math.max(screen.height, screen.width) * (devicePixelRatio || 1) >= 2160 ? 2160 : 1080,
  };
}

async function start() {
  const contentId = params.get('content') ?? 'm0-test-pattern';
  const res = await fetch('/v1/playback/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contentId,
      quality: params.get('quality') ?? qualityEl.value,
      capabilities: detectCapabilities(),
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    log(`session error ${res.status}: ${JSON.stringify(body)}`);
    state.errors.push(`session ${res.status}`);
    return;
  }
  state.sessionId = body.sessionId;
  log(`session ${body.sessionId} ${body.video.width}x${body.video.height} ${body.video.codecs}`);
  for (const d of body.decisions) log(`decision ${d.code}: ${d.message}`);

  state.engine = chooseEngine();
  log(`engine ${state.engine}`);
  if (state.engine === 'native') {
    video.src = body.masterPlaylistUrl;
  } else if (window.Hls?.isSupported()) {
    const hls = new window.Hls({ renderTextTracksNatively: true, enableWorker: true });
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      log(`hls.js ${data.fatal ? 'FATAL' : 'error'} ${data.type}/${data.details}`);
      if (data.fatal) state.errors.push(`${data.type}/${data.details}`);
    });
    hls.loadSource(body.masterPlaylistUrl);
    hls.attachMedia(video);
  } else {
    log('No HLS playback engine available');
    state.errors.push('no-engine');
    return;
  }
  video.addEventListener('error', () => {
    const code = video.error?.code ?? 0;
    log(`media error ${code}`);
    state.errors.push(`media-${code}`);
  });
  await video.play().catch((err) => log(`play() rejected: ${err.message}`));
}

document.getElementById('start')?.addEventListener('click', () => void start());
document.getElementById('seek')?.addEventListener('click', () => {
  video.currentTime += 60;
});
video.textTracks.addEventListener('addtrack', (e) => {
  log(`text track: ${e.track?.language} "${e.track?.label}"`);
});
if (params.get('autostart') === '1') void start();
