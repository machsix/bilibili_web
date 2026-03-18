/**
 * Bilibili Proxy Player — frontend logic
 *
 * Flow:
 *  1. User submits a playlist URL → POST /api/playlist → render sidebar
 *  2. User clicks an item (or auto-advance) → load video via proxy endpoints
 *  3. Audio-only toggle → switch to audio element + cover art display
 */

(() => {
  // ── DOM refs ──────────────────────────────────────────────────────────────
  const playlistUrlInput = document.getElementById('playlist-url');
  const loadBtn          = document.getElementById('load-btn');
  const clearBtn         = document.getElementById('clear-btn');
  const downloadBtn      = document.getElementById('download-btn');
  const downloadPopup    = document.getElementById('download-popup');
  const dlAudioOnly      = document.getElementById('dl-audio-only');
  const dlRedirect       = document.getElementById('dl-redirect');
  const dlLink           = document.getElementById('dl-link');
  const playlistEl       = document.getElementById('playlist');
  const countEl          = document.getElementById('playlist-count');
  const artContainer     = document.getElementById('artplayer');
  const audioPlayer      = document.getElementById('audio-player');
  const coverOverlay     = document.getElementById('cover-overlay');
  const coverImg         = document.getElementById('cover-img');
  const coverPageBadge   = document.getElementById('cover-page-badge');
  const coverTitle       = document.getElementById('cover-title');
  const spinner          = document.getElementById('spinner');
  const nowPlaying       = document.getElementById('now-playing');
  const prevBtn          = document.getElementById('prev-btn');
  const nextBtn          = document.getElementById('next-btn');
  const audioToggle      = document.getElementById('audio-only-toggle');
  const errorBanner      = document.getElementById('error-banner');
  const nowPlayingTextEl = document.createElement('span');
  nowPlayingTextEl.className = 'now-playing-text';
  nowPlaying.replaceChildren(nowPlayingTextEl);

  // ── State ─────────────────────────────────────────────────────────────────
  let playlist     = [];   // [{bvid, title, cover, duration, page}, ...]
  let currentIndex = -1;
  let audioOnly    = false;
  let art          = null;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // ── LocalStorage persistence ───────────────────────────────────────────────
  const LS_URL      = 'bilibili-last-url';
  const LS_PLAYLIST = 'bilibili-last-playlist';
  const LS_INDEX    = 'bilibili-last-index';

  function persistPlaylist() {
    localStorage.setItem(LS_URL,      playlistUrlInput.value.trim());
    localStorage.setItem(LS_PLAYLIST, JSON.stringify(playlist));
  }

  function persistIndex() {
    localStorage.setItem(LS_INDEX, String(currentIndex));
  }

  function clearPersisted() {
    localStorage.removeItem(LS_URL);
    localStorage.removeItem(LS_PLAYLIST);
    localStorage.removeItem(LS_INDEX);
  }

  function restorePersisted() {
    const savedUrl  = localStorage.getItem(LS_URL);
    const savedData = localStorage.getItem(LS_PLAYLIST);
    if (savedUrl) playlistUrlInput.value = savedUrl;
    if (!savedData) return;
    try {
      const items = JSON.parse(savedData);
      if (!Array.isArray(items) || !items.length) return;
      playlist = items;
      renderPlaylist();
      downloadBtn.disabled = false;
      const savedIdx = parseInt(localStorage.getItem(LS_INDEX) || '0', 10);
      playItem(Math.max(0, Math.min(savedIdx, playlist.length - 1)));
    } catch { /* ignore parse errors */ }
  }

  // ── Utility ───────────────────────────────────────────────────────────────
  function formatDuration(secs) {
    if (!secs) return '';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h
      ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${m}:${String(s).padStart(2,'0')}`;
  }

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.remove('hidden');
    setTimeout(() => errorBanner.classList.add('hidden'), 8000);
  }

  function showSpinner(on) {
    spinner.classList.toggle('hidden', !on);
  }

  function thumbUrl(url) {
    if (!url) return '';
    return `/api/thumb?url=${encodeURIComponent(url)}`;
  }

  function refreshNowPlayingScroll() {
    nowPlaying.classList.remove('scrolling');
    nowPlaying.style.removeProperty('--np-overflow');
    nowPlaying.style.removeProperty('--np-duration');

    requestAnimationFrame(() => {
      const overflow = Math.ceil(nowPlayingTextEl.scrollWidth - nowPlaying.clientWidth);
      if (overflow <= 8) return;
      const duration = Math.max(4, overflow / 35);
      nowPlaying.style.setProperty('--np-overflow', `${overflow}px`);
      nowPlaying.style.setProperty('--np-duration', `${duration.toFixed(2)}s`);
      nowPlaying.classList.add('scrolling');
    });
  }

  function setNowPlayingText(text) {
    nowPlayingTextEl.textContent = text;
    refreshNowPlayingScroll();
  }

  function updateMediaSession(idx) {
    if (!('mediaSession' in navigator)) return;
    const item = playlist[idx];
    if (!item) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title:   item.title,
      artwork: item.cover ? [{ src: thumbUrl(item.cover) }] : [],
    });
    navigator.mediaSession.setActionHandler('previoustrack',
      idx > 0 ? () => playItem(idx - 1) : null);
    navigator.mediaSession.setActionHandler('nexttrack',
      idx < playlist.length - 1 ? () => playItem(idx + 1) : null);
    // Suppress Safari's default ±10 s seek buttons so prev/next track show instead.
    try { navigator.mediaSession.setActionHandler('seekforward',  null); } catch {}
    try { navigator.mediaSession.setActionHandler('seekbackward', null); } catch {}
  }

  function destroyArt() {
    if (!art) return;
    try {
      if (art.dash) art.dash.reset();
      art.destroy(false);
    } catch {
      // ignore cleanup errors
    }
    art = null;
    artContainer.innerHTML = '';
  }

  function getVideoState() {
    if (!art) {
      return { currentTime: 0, muted: false, volume: 1 };
    }
    return {
      currentTime: Number(art.currentTime || 0),
      muted: !!art.muted,
      volume: Number(art.volume ?? 1),
    };
  }

  function resolveVideoSource(type, bvid, page) {
    if (type === 'dash' && isIOS) {
      // iOS Safari does not reliably support DASH via MSE/dash.js.
      return {
        url: `/api/stream/video/${bvid}?page=${page}&quality=0&redirect=1`,
        playerType: 'auto',
      };
    }
    if (type === 'dash') {
      return {
        url: `/api/stream/mpd/${bvid}.mpd?page=${page}`,
        playerType: 'dash',
      };
    }
    return {
      url: `/api/stream/video/${bvid}?page=${page}`,
      playerType: 'auto',
    };
  }

  function resolveAudioSource(bvid, page) {
    // Use lower complexity progressive stream on iOS for better compatibility.
    if (isIOS) return `/api/stream/audio/${bvid}?page=${page}&quality=0`;
    return `/api/stream/audio/${bvid}?page=${page}`;
  }

  async function createArtPlayer(url, type, state = {}) {
    destroyArt();
    showSpinner(true);

    art = new Artplayer({
      container: artContainer,
      url,
      type: type === 'dash' ? 'mpd' : 'auto',
      autoplay: true,
      autoPlayback: false,
      pip: true,
      fullscreen: true,
      fullscreenWeb: true,
      playbackRate: true,
      setting: true,
      muted: !!state.muted,
      volume: Number(state.volume ?? 1),
      customType: {
        mpd: (video, sourceUrl, artInstance) => {
          const player = dashjs.MediaPlayer().create();
          player.initialize(video, sourceUrl, true);
          artInstance.dash = player;
          artInstance.on('destroy', () => player.reset());
        },
      },
    });

    art.on('video:waiting', () => showSpinner(true));
    art.on('video:canplay', () => showSpinner(false));
    art.on('video:ended', onVideoEnded);

    await new Promise((resolve) => {
      art.on('ready', () => {
        const startAt = Number(state.currentTime || 0);
        if (startAt > 0) art.currentTime = startAt;
        art.play().catch(() => {});
        showSpinner(false);
        resolve();
      });
    });
  }

  // ── Playlist rendering ────────────────────────────────────────────────────
  function renderPlaylist() {
    playlistEl.innerHTML = '';
    countEl.textContent  = `${playlist.length} video${playlist.length !== 1 ? 's' : ''}`;

    playlist.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'playlist-item' + (idx === currentIndex ? ' active' : '');
      li.dataset.index = idx;
      const page = Number(item.page || 0);
      const multipage = !!item.multipage;


      li.innerHTML = `
        <div class="item-thumb-wrap">
          <img class="item-thumb" src="${thumbUrl(item.cover)}" alt="" loading="lazy" />
          ${multipage ? `<span class="item-page-badge">${page+1}</span>` : ''}
        </div>
        <div class="item-info">
          <div class="item-index">${idx + 1}</div>
          <div class="item-title">${escHtml(item.title)}</div>
          ${item.duration ? `<div class="item-duration">${formatDuration(item.duration)}</div>` : ''}
        </div>`;

      li.addEventListener('click', () => playItem(idx));
      playlistEl.appendChild(li);
    });
  }

  function setActiveItem(idx) {
    document.querySelectorAll('.playlist-item').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
    // Scroll active item into view
    const active = playlistEl.children[idx];
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Load playlist ─────────────────────────────────────────────────────────
  async function loadPlaylist() {
    const url = playlistUrlInput.value.trim();
    if (!url) return;

    loadBtn.disabled = true;
    loadBtn.textContent = 'Loading…';
    errorBanner.classList.add('hidden');

    try {
      const res = await fetch('/api/playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Failed to load playlist');

      playlist     = data.items || [];
      currentIndex = -1;

      if (!playlist.length) {
        showError('Playlist is empty or could not be fetched.');
        return;
      }
      renderPlaylist();
      persistPlaylist();
      downloadBtn.disabled = false;
      playItem(0);
    } catch (e) {
      showError(e.message);
    } finally {
      loadBtn.disabled = false;
      loadBtn.textContent = 'Load';
    }
  }

  // ── Play a specific item ──────────────────────────────────────────────────
  async function playItem(idx) {
    if (idx < 0 || idx >= playlist.length) return;
    currentIndex = idx;
    persistIndex();
    const item = playlist[idx];
    const part = Number(item.page || 0);

    setActiveItem(idx);
    if (item.multipage) {
      setNowPlayingText(`${idx + 1} / ${playlist.length}  –  ${item.title} (P${part + 1})`);
    } else {
      setNowPlayingText(`${idx + 1} / ${playlist.length}  –  ${item.title}`);
    }
    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx === playlist.length - 1;

    // Update cover for audio-only mode
    const page = Number(item.page || 0);
    coverImg.src   = thumbUrl(item.cover);
    if (page) {
      coverPageBadge.textContent = String(page);
      coverPageBadge.classList.remove('hidden');
    } else {
      coverPageBadge.textContent = '';
      coverPageBadge.classList.add('hidden');
    }
    coverTitle.textContent = item.title;

    // ── Media Session (lock screen controls) ────────────────────────────────
    updateMediaSession(idx);

    showSpinner(true);
    errorBanner.classList.add('hidden');

    try {
      const page = item.page ?? 0;
      await loadMedia(item.bvid, page);
    } catch (e) {
      showSpinner(false);
      showError(`Failed to load video: ${e.message}`);
    }
  }

  // ── Media loading ─────────────────────────────────────────────────────────
  async function loadMedia(bvid, page = 0) {
    // Fetch stream type info
    const infoRes = await fetch(`/api/stream/info/${bvid}?page=${page}`);
    if (!infoRes.ok) {
      const err = await infoRes.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${infoRes.status}`);
    }
    const { type } = await infoRes.json();

    const source = resolveVideoSource(type, bvid, page);
    const audioUrl = resolveAudioSource(bvid, page);
    const state = getVideoState();

    if (audioOnly) {
      // Audio-only mode
      stopVideo();
      audioPlayer.src = audioUrl;
      audioPlayer.load();
      audioPlayer.muted = !!state.muted;
      audioPlayer.volume = Number(state.volume ?? 1);
      showCoverOverlay(true);
      showSpinner(false);
      await audioPlayer.play().catch(() => {});
    } else {
      // Video+audio mode
      hideCoverOverlay();
      audioPlayer.pause();
      audioPlayer.src = '';

      await createArtPlayer(source.url, source.playerType, state);
    }
  }

  // ── Cover overlay ─────────────────────────────────────────────────────────
  function showCoverOverlay(show) {
    coverOverlay.style.display = show ? 'flex' : 'none';
    artContainer.style.display = show ? 'none' : 'block';
    audioPlayer.style.display  = show ? 'block' : 'none';
  }
  function hideCoverOverlay() { showCoverOverlay(false); }

  function stopVideo() {
    destroyArt();
  }

  // ── Auto-advance ──────────────────────────────────────────────────────────
  function onVideoEnded() {
    if (currentIndex < playlist.length - 1) {
      playItem(currentIndex + 1);
    }
  }

  function onAudioEnded() {
    if (currentIndex < playlist.length - 1) {
      playItem(currentIndex + 1);
    }
  }

  audioPlayer.addEventListener('ended', onAudioEnded);
  audioPlayer.addEventListener('waiting', () => showSpinner(true));
  audioPlayer.addEventListener('canplay', () => showSpinner(false));
  // Re-apply Media Session handlers every time audio plays — iOS Safari resets
  // them to seek-button defaults when play() fires on an <audio> element.
  audioPlayer.addEventListener('play', () => updateMediaSession(currentIndex));

  // ── Controls ──────────────────────────────────────────────────────────────
  prevBtn.addEventListener('click', () => playItem(currentIndex - 1));
  nextBtn.addEventListener('click', () => playItem(currentIndex + 1));

  loadBtn.addEventListener('click', loadPlaylist);
  playlistUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadPlaylist();
  });

  clearBtn.addEventListener('click', () => {
    clearPersisted();
    playlistUrlInput.value = '';
    playlist     = [];
    currentIndex = -1;
    renderPlaylist();
    stopVideo();
    audioPlayer.pause();
    audioPlayer.src = '';
    hideCoverOverlay();
    setNowPlayingText('No video loaded');
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    downloadBtn.disabled = true;
    errorBanner.classList.add('hidden');
    downloadPopup.classList.add('hidden');
  });

  // ── Download M3U popup ────────────────────────────────────────────────────
  function updateDlLink() {
    const url = playlistUrlInput.value.trim();
    if (!url) return;
    const params = new URLSearchParams({ url });
    if (dlAudioOnly.checked) params.set('video', '0');
    if (dlRedirect.checked)  params.set('redirect', '1');
    dlLink.href = `/m3u?${params}`;
  }

  downloadBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    updateDlLink();
    downloadPopup.classList.toggle('hidden');
  });

  dlAudioOnly.addEventListener('change', updateDlLink);
  dlRedirect.addEventListener('change', updateDlLink);

  dlLink.addEventListener('click', () => {
    downloadPopup.classList.add('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!downloadPopup.contains(e.target) && e.target !== downloadBtn) {
      downloadPopup.classList.add('hidden');
    }
  });

  // ── Audio-only toggle ─────────────────────────────────────────────────────
  audioToggle.addEventListener('change', async () => {
    audioOnly = audioToggle.checked;

    if (currentIndex < 0 || !playlist.length) return;
    const item = playlist[currentIndex];
    const page = item.page ?? 0;

    const audioUrl = resolveAudioSource(item.bvid, page);

    if (audioOnly) {
      // Switch to audio-only
      const state = getVideoState();
      stopVideo();
      showCoverOverlay(true);
      audioPlayer.src = audioUrl;
      audioPlayer.load();
      audioPlayer.muted = !!state.muted;
      audioPlayer.volume = Number(state.volume ?? 1);
      audioPlayer.currentTime = Number(state.currentTime || 0);
      await audioPlayer.play().catch(() => {});
    } else {
      // Switch back to video
      const audioTime = audioPlayer.currentTime;
      const wasMuted = audioPlayer.muted;
      const volume = audioPlayer.volume;
      audioPlayer.pause();
      audioPlayer.src = '';
      hideCoverOverlay();

      const infoRes = await fetch(`/api/stream/info/${item.bvid}?page=${page}`);
      if (!infoRes.ok) {
        const err = await infoRes.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${infoRes.status}`);
      }
      const { type } = await infoRes.json();
      const source = resolveVideoSource(type, item.bvid, page);

      await createArtPlayer(source.url, source.playerType, {
        muted: wasMuted,
        volume,
        currentTime: audioTime,
      });
    }
  });

  // ── Initial state ─────────────────────────────────────────────────────────
  prevBtn.disabled = true;
  nextBtn.disabled = true;
  showCoverOverlay(false);
  setNowPlayingText('No video loaded');
  window.addEventListener('resize', refreshNowPlayingScroll);

  // Auto-load from /play?... redirect or direct URL param
  const autoload = new URLSearchParams(window.location.search).get('autoload');
  if (autoload) {
    playlistUrlInput.value = autoload;
    // Clean the URL bar without reloading the page
    history.replaceState(null, '', '/');
    loadPlaylist();
  } else {
    restorePersisted();
  }
})();
