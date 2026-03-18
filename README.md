# Bilibili Player

A self-hosted reverse proxy player for Bilibili videos and playlists, with a web interface and M3U export for external players.

## Features

- **Web player (Artplayer)** — playlist UI with Artplayer + dash.js playback
- **DASH MPD support** — backend-generated MPD endpoint for browser DASH playback
- **iOS compatibility path** — Safari/iPhone uses progressive + CDN redirect fallback for better reliability
- **Audio-only mode** — hides video, shows cover art; supports iOS lock screen next/previous track controls
- **Persistent state** — remembers last playlist and playback position across page refreshes
- **M3U export** — download playlists for external players (mpv, VLC, Evermusic, etc.)
- **Merged stream endpoint** — ffmpeg mux endpoint available for external players that need a single stream
- **Direct CDN redirect** — option to redirect external players straight to Bilibili's CDN for faster start and no proxy overhead
- **Deep link** — open the web player with a playlist pre-loaded via `/play?...`
- **Docker** — multi-arch image (amd64 + arm64), configurable port, IPv6 support

## Running

### Docker (recommended)

```bash
docker run -p 8000:8000 ghcr.io/<your-username>/bilibili_web:latest
```

Custom port:
```bash
docker run -e PORT=9000 -p 9000:9000 ghcr.io/<your-username>/bilibili_web:latest
```

Force a clean rebuild:
```bash
docker build --no-cache -t bilibili-player .
```

### Local

```bash
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## Web Player

Open `http://localhost:8000` and paste any supported URL into the input box, then press **Enter** or the load button.

| URL type | Example |
|---|---|
| Collection (合集) | `https://space.bilibili.com/94286793/channel/collectiondetail?sid=7005584` |
| Series (系列) | `https://space.bilibili.com/94286793/channel/seriesdetail?sid=7005584` |
| New list format | `https://space.bilibili.com/94286793/lists/7005584` |
| Favorite list | `https://space.bilibili.com/1296787/favlist?fid=3928871687` |
| Single video | `https://www.bilibili.com/video/BVxxxxxxxxxx` |

Use the **⬇ download button** in the header to export the current playlist as an M3U file, with options for audio-only and direct CDN redirect.

## Deep Link (`/play`)

Open the web player with a playlist pre-loaded:

```
/play?uid=94286793&sid=7005584    # collection or series
/play?fid=3928871687              # favorite list
/play?bvid=BV15EArzAEoE          # single video
```

## Music Mode (`/music`)

Open a mobile-first pure music player (audio-only UI) with the same arguments as `/play`:

```
/music?uid=94286793&sid=7005584    # collection or series
/music?fid=3928871687              # favorite list
/music?bvid=BV15EArzAEoE           # single video
/music                              # open music UI directly
```

## M3U Endpoint

Generate a playlist file for external players. The downloaded file includes a comment with the source URL for easy re-downloading.

| Parameter | Description |
|---|---|
| `url` | Any supported Bilibili URL |
| `uid` + `sid` | Collection or series by user ID + season/series ID |
| `fid` | Favorite list ID |
| `video=0` | Audio-only tracks (default: `1` = video stream route) |
| `quality` | Audio quality when `video=0`: `0` (low), `1` (medium), `2` (high, default) |
| `redirect` | `1` to return CDN redirect URLs, `0` to keep proxy URLs; default is auto |

```
/m3u?url=https://space.bilibili.com/94286793/lists/7005584
/m3u?uid=94286793&sid=7005584
/m3u?fid=3928871687
/m3u?fid=3928871687&video=0&redirect=1
/m3u?fid=3928871687&video=0&quality=2
```

Play directly with mpv:
```bash
mpv "http://localhost:8000/m3u?uid=94286793&sid=7005584"
```

### `redirect=1` vs default

| | Default (proxy) | `redirect=1` |
|---|---|---|
| Stream route | Browser/player → your server → Bilibili CDN | Browser/player → your server (resolve) → 302 → Bilibili CDN |
| Start speed | Slower (API call + proxy) | Faster |
| Reliability | Stable (your server buffers) | Depends on CDN expiry (~2h) |
| Best for | Web browser, mpv on desktop | Mobile apps (Evermusic, VLC on iOS) |

Default behavior used by `/m3u` today:

- `video=1`: defaults to `quality=0` and `redirect=1`
- `video=0`: defaults to proxy (`redirect=0`) unless explicitly overridden

## Stream Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/stream/info/{bvid}?page=0` | Returns stream type (`dash` / `mp4` / `flv`) |
| `GET /api/stream/mpd/{bvid}.mpd?page=0&quality=2` | Generated DASH MPD for Artplayer/dash.js |
| `GET /api/stream/video/{bvid}?page=0&quality=1` | Video stream (or progressive fallback depending on quality) |
| `GET /api/stream/audio/{bvid}?page=0&quality=1` | Audio stream (`Content-Type: audio/mp4`) |
| `GET /api/stream/video/{bvid}?page=0&redirect=1` | 302 redirect to Bilibili CDN video URL |
| `GET /api/stream/audio/{bvid}?page=0&redirect=1` | 302 redirect to Bilibili CDN audio URL |
| `GET /api/stream/merged/{bvid}?page=0` | ffmpeg muxed video+audio (single stream output) |
| `GET /api/thumb?url=<cdn-url>` | Proxy a Bilibili thumbnail (adds required Referer header) |

Web player behavior today:

- Desktop/Android: DASH videos use `/api/stream/mpd/{bvid}.mpd` with Artplayer + dash.js
- iOS Safari: DASH videos fall back to `/api/stream/video/...&quality=0&redirect=1`
- Audio-only on iOS uses low-complexity audio stream for compatibility

## IPv6

The Docker image binds to `::` (dual-stack). Enable IPv6 in the Docker daemon if needed:

```json
// /etc/docker/daemon.json
{
  "ipv6": true,
  "fixed-cidr-v6": "fd00::/80"
}
```

Then restart Docker: `sudo systemctl restart docker`
