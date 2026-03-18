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
  const videoPlayer      = document.getElementById('video-player');
  const audioPlayer      = document.getElementById('audio-player');
  const coverOverlay     = document.getElementById('cover-overlay');
  const coverImg         = document.getElementById('cover-img');
  const coverTitle       = document.getElementById('cover-title');
  const spinner          = document.getElementById('spinner');
  const nowPlaying       = document.getElementById('now-playing');
  const prevBtn          = document.getElementById('prev-btn');
  const nextBtn          = document.getElementById('next-btn');
  const audioToggle      = document.getElementById('audio-only-toggle');
  const errorBanner      = document.getElementById('error-banner');

  // ── State ─────────────────────────────────────────────────────────────────
  let playlist     = [];   // [{bvid, title, cover, duration, page}, ...]
  let currentIndex = -1;
  let audioOnly    = false;

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

  // ── Playlist rendering ────────────────────────────────────────────────────
  function renderPlaylist() {
    playlistEl.innerHTML = '';
    countEl.textContent  = `${playlist.length} video${playlist.length !== 1 ? 's' : ''}`;

    playlist.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'playlist-item' + (idx === currentIndex ? ' active' : '');
      li.dataset.index = idx;

      li.innerHTML = `
        <img class="item-thumb" src="${thumbUrl(item.cover)}" alt="" loading="lazy" />
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

    setActiveItem(idx);
    nowPlaying.textContent = `${idx + 1} / ${playlist.length}  –  ${item.title}`;
    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx === playlist.length - 1;

    // Update cover for audio-only mode
    coverImg.src   = thumbUrl(item.cover);
    coverTitle.textContent = item.title;

    // ── Media Session (lock screen controls) ────────────────────────────────
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title:   item.title,
        artwork: item.cover ? [{ src: thumbUrl(item.cover) }] : [],
      });
      navigator.mediaSession.setActionHandler('previoustrack',
        idx > 0 ? () => playItem(idx - 1) : null);
      navigator.mediaSession.setActionHandler('nexttrack',
        idx < playlist.length - 1 ? () => playItem(idx + 1) : null);
    }

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

    const videoUrl = `/api/stream/video/${bvid}?page=${page}`;
    const audioUrl = `/api/stream/audio/${bvid}?page=${page}`;

    if (audioOnly) {
      // Audio-only mode
      stopVideo();
      audioPlayer.src = audioUrl;
      audioPlayer.load();
      showCoverOverlay(true);
      showSpinner(false);
      await audioPlayer.play().catch(() => {});
    } else {
      // Video+audio mode
      hideCoverOverlay();
      audioPlayer.src = '';

      if (type === 'dash') {
        // For DASH we serve separate streams — use a combined source trick:
        // We proxy video via /api/stream/video which contains the video track,
        // and audio via /api/stream/audio which contains the audio track.
        // Modern browsers can't combine two streams natively, so we serve the
        // best single stream as the video src (the DASH video track contains
        // no audio; use audio proxy as a hidden audio element synced to video).
        videoPlayer.src = videoUrl;
        videoPlayer.load();

        // Use a second hidden audio element synced to video for DASH audio
        syncAudioToVideo(audioUrl);
      } else {
        // MP4/FLV — single file with video+audio
        videoPlayer.src = videoUrl;
        videoPlayer.load();
        stopSyncAudio();
      }

      showSpinner(false);
      await videoPlayer.play().catch(() => {});
    }
  }

  // ── DASH audio sync ───────────────────────────────────────────────────────
  // Because browsers can't MSE-merge two proxy streams easily, we play the
  // DASH audio track in a hidden <audio> element synced to the video element.
  let syncAudio = null;

  function stopSyncAudio() {
    if (syncAudio) {
      syncAudio.pause();
      syncAudio.src = '';
      syncAudio.remove();
      syncAudio = null;
    }
  }

  function syncAudioToVideo(audioUrl) {
    stopSyncAudio();
    syncAudio = document.createElement('audio');
    syncAudio.src = audioUrl;
    syncAudio.preload = 'auto';
    syncAudio.style.display = 'none';
    document.body.appendChild(syncAudio);

    videoPlayer.addEventListener('play',  onVideoPlay,  { signal: syncAudioAbortController.signal });
    videoPlayer.addEventListener('pause', onVideoPause, { signal: syncAudioAbortController.signal });
    videoPlayer.addEventListener('seeked', onVideoSeeked, { signal: syncAudioAbortController.signal });
    videoPlayer.addEventListener('ended', onVideoEnded, { signal: syncAudioAbortController.signal });

    // Kickoff
    syncAudio.currentTime = videoPlayer.currentTime;
    if (!videoPlayer.paused) syncAudio.play().catch(() => {});
  }

  let syncAudioAbortController = new AbortController();

  function resetSyncController() {
    syncAudioAbortController.abort();
    syncAudioAbortController = new AbortController();
  }

  function onVideoPlay()  { syncAudio?.play().catch(() => {}); }
  function onVideoPause() { syncAudio?.pause(); }
  function onVideoSeeked() {
    if (syncAudio) {
      syncAudio.currentTime = videoPlayer.currentTime;
      if (!videoPlayer.paused) syncAudio.play().catch(() => {});
    }
  }

  // ── Cover overlay ─────────────────────────────────────────────────────────
  function showCoverOverlay(show) {
    coverOverlay.style.display = show ? 'flex' : 'none';
    videoPlayer.style.display  = show ? 'none' : 'block';
    audioPlayer.style.display  = show ? 'block' : 'none';
  }
  function hideCoverOverlay() { showCoverOverlay(false); }

  function stopVideo() {
    resetSyncController();
    stopSyncAudio();
    videoPlayer.pause();
    videoPlayer.src = '';
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

  videoPlayer.addEventListener('ended', onVideoEnded);
  audioPlayer.addEventListener('ended', onAudioEnded);

  videoPlayer.addEventListener('waiting', () => showSpinner(true));
  videoPlayer.addEventListener('canplay', () => showSpinner(false));
  audioPlayer.addEventListener('waiting', () => showSpinner(true));
  audioPlayer.addEventListener('canplay', () => showSpinner(false));

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
    nowPlaying.textContent = 'No video loaded';
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

    const audioUrl = `/api/stream/audio/${item.bvid}?page=${page}`;
    const videoUrl = `/api/stream/video/${item.bvid}?page=${page}`;

    if (audioOnly) {
      // Switch to audio-only
      const videoTime = videoPlayer.currentTime;
      const wasMuted = videoPlayer.muted;
      const volume = videoPlayer.volume;
      stopVideo();
      showCoverOverlay(true);
      audioPlayer.src = audioUrl;
      audioPlayer.load();
      audioPlayer.muted = wasMuted;
      audioPlayer.volume = volume;
      audioPlayer.currentTime = videoTime;
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

      resetSyncController();
      videoPlayer.src = videoUrl;
      videoPlayer.load();
      videoPlayer.muted = wasMuted;
      videoPlayer.volume = volume;
      videoPlayer.currentTime = audioTime;

      if (type === 'dash') {
        syncAudioToVideo(audioUrl);
      } else {
        stopSyncAudio();
      }

      await videoPlayer.play().catch(() => {});
    }
  });

  // ── Initial state ─────────────────────────────────────────────────────────
  prevBtn.disabled = true;
  nextBtn.disabled = true;
  showCoverOverlay(false);

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
