(() => {
  const playlistUrlInput = document.getElementById('playlist-url');
  const loadBtn = document.getElementById('load-btn');
  const clearBtn = document.getElementById('clear-btn');
  const playlistCount = document.getElementById('playlist-count');
  const playlistEl = document.getElementById('playlist');
  const audioPlayer = document.getElementById('audio-player');
  const coverImg = document.getElementById('cover-img');
  const trackTitle = document.getElementById('track-title');
  const trackSubtitle = document.getElementById('track-subtitle');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const playToggleBtn = document.getElementById('play-toggle-btn');
  const playToggleIcon = document.getElementById('play-toggle-icon');
  const errorBanner = document.getElementById('error-banner');

  const LS_URL = 'bilibili-music-last-url';
  const LS_PLAYLIST = 'bilibili-music-last-playlist';
  const LS_INDEX = 'bilibili-music-last-index';

  let playlist = [];
  let currentIndex = -1;
  let storageEnabled = false;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function initStorage() {
    try {
      const probe = '__music_storage_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      storageEnabled = true;
    } catch {
      storageEnabled = false;
    }
  }

  function lsGet(key) {
    if (!storageEnabled) return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function lsSet(key, value) {
    if (!storageEnabled) return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Ignore storage write failures (quota/private mode).
    }
  }

  function lsRemove(key) {
    if (!storageEnabled) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore storage remove failures.
    }
  }

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.classList.remove('hidden');
    window.setTimeout(() => {
      errorBanner.classList.add('hidden');
    }, 8000);
  }

  function clearError() {
    errorBanner.classList.add('hidden');
    errorBanner.textContent = '';
  }

  function formatDuration(seconds) {
    if (!seconds) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function thumbUrl(url) {
    if (!url) return '';
    return `/api/thumb?url=${encodeURIComponent(url)}`;
  }

  function resolveAudioSource(bvid, page) {
    // if (isIOS) {
    //   return `/api/stream/audio/${bvid}?page=${page}&quality=0&redirect=1`;
    // }
    return `/api/stream/audio/${bvid}?page=${page}&quality=1`;
  }

  function buildBilibiliUrlFromParams(params) {
    const bvid = params.get('bvid');
    const fid = params.get('fid');
    const uid = params.get('uid');
    const sid = params.get('sid');

    if (bvid) {
      return `https://www.bilibili.com/video/${bvid}`;
    }
    if (fid) {
      return `https://space.bilibili.com/0/favlist?fid=${fid}`;
    }
    if (uid && sid) {
      return `https://space.bilibili.com/${uid}/lists/${sid}`;
    }
    return null;
  }

  function canonicalMusicPathFromInput(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return null;
    }

    const pathname = parsed.pathname || '';

    const bvidMatch = pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
    if (bvidMatch) {
      return `/music?bvid=${encodeURIComponent(bvidMatch[1])}`;
    }

    const fidFromPath = pathname.match(/\/ml(\d+)/i);
    if (fidFromPath) {
      return `/music?fid=${fidFromPath[1]}`;
    }

    const fid = parsed.searchParams.get('fid');
    if (fid && /^\d+$/.test(fid)) {
      return `/music?fid=${fid}`;
    }

    const uidFromPath = pathname.match(/^\/(\d+)(?:\/|$)/);
    const uid = uidFromPath ? uidFromPath[1] : null;
    const sidFromLists = pathname.match(/\/lists\/(\d+)/);
    const sid = sidFromLists ? sidFromLists[1] : parsed.searchParams.get('sid');

    if (uid && sid && /^\d+$/.test(sid)) {
      return `/music?uid=${uid}&sid=${sid}`;
    }

    return null;
  }

  function updatePlayToggleIcon() {
    playToggleIcon.textContent = audioPlayer.paused ? 'play_arrow' : 'pause';
  }

  function persistPlaylist() {
    lsSet(LS_URL, playlistUrlInput.value.trim());
    lsSet(LS_PLAYLIST, JSON.stringify(playlist));
  }

  function persistIndex() {
    lsSet(LS_INDEX, String(currentIndex));
  }

  function clearPersisted() {
    lsRemove(LS_URL);
    lsRemove(LS_PLAYLIST);
    lsRemove(LS_INDEX);
  }

  function renderPlaylist() {
    playlistEl.innerHTML = '';
    playlistCount.textContent = `${playlist.length} track${playlist.length === 1 ? '' : 's'}`;

    playlist.forEach((item, idx) => {
      const row = document.createElement('tr');
      const isActive = idx === currentIndex;
      row.className = `track-row${isActive ? ' active' : ''}`;
      row.innerHTML = `
        <td class="col-index">${idx + 1}</td>
        <td class="col-title">${escapeHtml(item.title || item.bvid)}</td>
        <td class="col-duration">${formatDuration(item.duration || 0)}</td>
      `;

      row.addEventListener('click', () => {
        playItem(idx);
      });

      playlistEl.appendChild(row);
    });
  }

  function setActiveItem(idx) {
    document.querySelectorAll('.track-row').forEach((item, index) => {
      item.classList.toggle('active', index === idx);
    });
    const active = playlistEl.children[idx];
    if (active) {
      active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function updateMetaForItem(item, idx) {
    const title = item.title || item.bvid;
    const part = Number(item.page || 0) + 1;

    trackTitle.textContent = title;
    if (item.multipage) {
      trackSubtitle.textContent = `${idx + 1}/${playlist.length} • Part ${part}`;
    } else {
      trackSubtitle.textContent = `${idx + 1}/${playlist.length}`;
    }

    if (item.cover) {
      coverImg.src = thumbUrl(item.cover);
    } else {
      coverImg.removeAttribute('src');
    }

    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= playlist.length - 1;
  }

  function updateMediaSession(idx) {
    if (!('mediaSession' in navigator)) return;
    const item = playlist[idx];
    if (!item) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title || item.bvid,
      artwork: item.cover ? [{ src: thumbUrl(item.cover) }] : [],
    });

    navigator.mediaSession.setActionHandler('previoustrack', idx > 0 ? () => playItem(idx - 1) : null);
    navigator.mediaSession.setActionHandler('nexttrack', idx < playlist.length - 1 ? () => playItem(idx + 1) : null);
    try {
      navigator.mediaSession.setActionHandler('seekforward', null);
      navigator.mediaSession.setActionHandler('seekbackward', null);
    } catch {
      // Some browsers do not allow overriding seek handlers.
    }
  }

  async function playItem(idx) {
    if (idx < 0 || idx >= playlist.length) return;

    currentIndex = idx;
    persistIndex();
    clearError();

    const item = playlist[idx];
    const page = item.page ?? 0;
    const audioUrl = resolveAudioSource(item.bvid, page);

    updateMetaForItem(item, idx);
    setActiveItem(idx);
    updateMediaSession(idx);

    audioPlayer.src = audioUrl;
    audioPlayer.load();

    try {
      await audioPlayer.play();
      updatePlayToggleIcon();
    } catch (err) {
      updatePlayToggleIcon();
      showError(err.message || 'Failed to start audio playback.');
    }
  }

  function primeItem(idx) {
    if (idx < 0 || idx >= playlist.length) return;
    currentIndex = idx;
    persistIndex();

    const item = playlist[idx];
    const page = item.page ?? 0;
    const audioUrl = resolveAudioSource(item.bvid, page);

    updateMetaForItem(item, idx);
    setActiveItem(idx);
    updateMediaSession(idx);

    audioPlayer.src = audioUrl;
    audioPlayer.load();
    updatePlayToggleIcon();
  }

  async function loadPlaylist(options = {}) {
    const {
      shouldAutoplay = true,
      canonicalizeUrl = true,
    } = options;

    const url = playlistUrlInput.value.trim();
    if (!url) return;

    clearError();
    loadBtn.disabled = true;
    loadBtn.textContent = 'Loading...';

    try {
      const res = await fetch('/api/playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Failed to load playlist.');
      }

      playlist = data.items || [];
      currentIndex = -1;

      if (!playlist.length) {
        throw new Error('Playlist is empty or unavailable.');
      }

      if (canonicalizeUrl) {
        const canonicalPath = canonicalMusicPathFromInput(url);
        const currentPathWithQuery = `${window.location.pathname}${window.location.search}`;
        if (canonicalPath && canonicalPath !== currentPathWithQuery) {
          history.replaceState(null, '', canonicalPath);
        }
      }

      persistPlaylist();
      renderPlaylist();
      if (shouldAutoplay) {
        await playItem(0);
      } else {
        primeItem(0);
      }
    } catch (err) {
      showError(err.message || 'Failed to load playlist.');
    } finally {
      loadBtn.disabled = false;
      loadBtn.textContent = 'Load';
    }
  }

  function clearAll() {
    clearPersisted();
    clearError();

    playlist = [];
    currentIndex = -1;

    playlistUrlInput.value = '';
    playlistEl.innerHTML = '';
    playlistCount.textContent = '0 tracks';

    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();

    trackTitle.textContent = 'No track loaded';
    trackSubtitle.textContent = 'Paste a playlist URL to begin';
    coverImg.removeAttribute('src');

    prevBtn.disabled = true;
    nextBtn.disabled = true;
    updatePlayToggleIcon();
  }

  function restorePersisted() {
    const savedUrl = lsGet(LS_URL);
    const savedData = lsGet(LS_PLAYLIST);
    if (savedUrl) {
      playlistUrlInput.value = savedUrl;
    }
    if (!savedData) return;

    try {
      const items = JSON.parse(savedData);
      if (!Array.isArray(items) || items.length === 0) return;

      playlist = items;
      renderPlaylist();

      const savedIndex = Number.parseInt(lsGet(LS_INDEX) || '0', 10);
      const index = Number.isNaN(savedIndex)
        ? 0
        : Math.max(0, Math.min(savedIndex, playlist.length - 1));

      const item = playlist[index];
      currentIndex = index;
      setActiveItem(index);
      updateMetaForItem(item, index);
      updatePlayToggleIcon();
      updateMediaSession(index);
    } catch {
      // Ignore malformed persisted data.
    }
  }

  loadBtn.addEventListener('click', () => {
    loadPlaylist({ shouldAutoplay: true, canonicalizeUrl: true });
  });
  clearBtn.addEventListener('click', clearAll);
  playlistUrlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      loadPlaylist({ shouldAutoplay: true, canonicalizeUrl: true });
    }
  });

  prevBtn.addEventListener('click', () => {
    if (currentIndex > 0) {
      playItem(currentIndex - 1);
    }
  });

  nextBtn.addEventListener('click', () => {
    if (currentIndex < playlist.length - 1) {
      playItem(currentIndex + 1);
    }
  });

  playToggleBtn.addEventListener('click', async () => {
    if (currentIndex < 0) return;

    if (audioPlayer.paused) {
      try {
        await audioPlayer.play();
      } catch (err) {
        showError(err.message || 'Unable to resume playback.');
      }
    } else {
      audioPlayer.pause();
    }
    updatePlayToggleIcon();
  });

  audioPlayer.addEventListener('play', () => {
    updatePlayToggleIcon();
    updateMediaSession(currentIndex);
  });

  audioPlayer.addEventListener('pause', updatePlayToggleIcon);

  audioPlayer.addEventListener('ended', () => {
    if (currentIndex < playlist.length - 1) {
      playItem(currentIndex + 1);
    } else {
      updatePlayToggleIcon();
    }
  });

  // Keep UI controls in sync even if user presses native audio controls.
  audioPlayer.addEventListener('loadeddata', updatePlayToggleIcon);

  prevBtn.disabled = true;
  nextBtn.disabled = true;
  updatePlayToggleIcon();
  initStorage();

  const params = new URLSearchParams(window.location.search);
  const autoload = params.get('autoload');
  const directUrl = buildBilibiliUrlFromParams(params);
  const startupUrl = autoload || directUrl;

  if (startupUrl) {
    playlistUrlInput.value = startupUrl;
    // Startup loads are not user gestures on iOS, so prepare first track
    // without forcing autoplay.
    loadPlaylist({ shouldAutoplay: false, canonicalizeUrl: true });
  } else {
    restorePersisted();
  }
})();
