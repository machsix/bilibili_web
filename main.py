"""
FastAPI application entry point.
Run with: venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

# Configure bilibili-api to use curl_cffi with Chrome fingerprint to avoid
# Bilibili's risk-control (-352) errors on API calls.
from bilibili_api import select_client, request_settings
select_client("curl_cffi")
request_settings.set("impersonate", "chrome131")

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, RedirectResponse
from pydantic import BaseModel
from typing import Optional

from api.playlist import get_playlist, _fetch_season, _fetch_series, _fetch_favorite
from api.video import get_video_info
from api.proxy import router as proxy_router

from pathlib import Path
import re
import base64

app = FastAPI(title="Bilibili Proxy Player")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def cache_control_middleware(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif request.url.path in {"/", "/music"}:
        response.headers["Cache-Control"] = "no-cache"
    return response

# ── Streaming proxy routes ─────────────────────────────────────────────────────
app.include_router(proxy_router)


# ── Playlist API ───────────────────────────────────────────────────────────────
class PlaylistRequest(BaseModel):
    url: str


@app.post("/api/playlist")
async def api_playlist(req: PlaylistRequest):
    try:
        items = await get_playlist(req.url)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch playlist: {e}")
    return {"items": items}


# ── Video info API ─────────────────────────────────────────────────────────────
@app.get("/api/video/{bvid}/info")
async def api_video_info(bvid: str, page: int = 0):
    try:
        info = await get_video_info(bvid, page)
    except Exception as e:
        raise HTTPException(500, str(e))
    return info


# ── M3U playlist API ───────────────────────────────────────────────────────────
@app.get("/m3u")
async def m3u_playlist(request: Request, video: int = 1, redirect: int = -1,
                       quality: int = 1,
                       url: Optional[str] = None,
                       uid: Optional[int] = None, sid: Optional[int] = None, fid: Optional[int] = None):
    """Generate an M3U playlist for an external player (e.g. mpv, VLC).

    Parameters
    ----------
    url      : Any supported Bilibili URL (playlist, collection, favorite, video)
    uid      : Bilibili user ID (mid) — required with sid
    sid      : Season or series ID
    fid      : Favorite list ID (media_id) — alternative to uid+sid
    video    : 1 (default) → merged video+audio; 0 → audio-only
    redirect : 1 → whether to redirect to the CDN
    The following only applies to audio stream, i.e. video=0
    quality  : 0 → lowest quality (flv if video=1, 64Kbps if video=0)
               1 → medium quality (1080P if video=1, 132Kbps if video=0)
               2 (default) → highest quality available (up to 4K for video, 192Kbps for audio)
    """
    if url:
        try:
            items = await get_playlist(url)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(500, str(e))
        label = "playlist"
    elif fid:
        items = await _fetch_favorite(fid)
        label = f"fav_{fid}"
    elif uid and sid:
        items = await _fetch_season(uid, sid)
        if not items:
            items = await _fetch_series(uid, sid)
        label = f"{uid}_{sid}"
    else:
        raise HTTPException(400, "Provide url, fid, or both uid and sid")

    if not items:
        raise HTTPException(404, "No videos found")

    base = str(request.base_url).rstrip("/")
    if video:
        # use low quality flv stream from bilibili directly
        stream_path = "video"
        quality = 0
        redirect = 0 if redirect == -1 else redirect
    else:
        stream_path = "audio"
        quality = max(int(quality),1)
        redirect = 0 if redirect == -1 else redirect
    query_params = f"quality={quality}&redirect={redirect}"

    lines = ["#EXTM3U", f"# Source: {request.url}"]
    for item in items:
        bvid = item.bvid
        duration = int(item.duration or 0)
        page = int(item.page or 0)
        title = item.title or bvid
        vid_id = bvid
        owner = item.owner or "Unknown"
        if item.multipage:
            title += f" (P{item.page+1})"
            vid_id += f"_p{page}"


        lines.append(f'#EXTINF:{duration} tvg-id="{vid_id}"')
        if item.cover:
            base64_cover = base64.b64encode(item.cover.encode()).decode()
            cover_url = str(request.url_for("proxy_thumb").include_query_params(base64url=base64_cover))
            lines[-1] += f' tvg-logo="{cover_url}" cover="{cover_url}" logo="{cover_url}", {title}'
        else:
            lines[-1] += f', {title}'
        lines.append(f"{base}/api/stream/{stream_path}/{bvid}/{page}?{query_params}")

    return PlainTextResponse(
        "\n".join(lines) + "\n",
        media_type="application/x-mpegurl",
        headers={"Content-Disposition": f'attachment; filename="{label}.m3u"'},
    )


# ── Play endpoint — open web player directly ──────────────────────────────────
@app.get("/play")
async def play(uid: Optional[int] = None, sid: Optional[int] = None, fid: Optional[int] = None, bvid: Optional[str] = None):
    """Redirect to the web player with a playlist pre-loaded.

    /play?uid=94286793&sid=7005584   — season or series
    /play?fid=3928871687             — favorite list
    /play?bvid=BV15EArzAEoE         — single video
    """
    if bvid:
        url = f"https://www.bilibili.com/video/{bvid}"
    elif fid:
        url = f"https://space.bilibili.com/0/favlist?fid={fid}"
    elif uid and sid:
        url = f"https://space.bilibili.com/{uid}/lists/{sid}"
    else:
        raise HTTPException(400, "Provide bvid, fid, or both uid and sid")
    from urllib.parse import quote
    return RedirectResponse(f"/?autoload={quote(url)}", status_code=302)


@app.get("/music")
async def music(uid: Optional[int] = None, sid: Optional[int] = None, fid: Optional[int] = None, bvid: Optional[str] = None):
    """Open the mobile-first music player with a playlist pre-loaded.

    /music?uid=94286793&sid=7005584   — season or series
    /music?fid=3928871687             — favorite list
    /music?bvid=BV15EArzAEoE          — single video
    /music                             — open music player directly
    """
    if (uid is not None and sid is None) or (uid is None and sid is not None):
        raise HTTPException(400, "Provide bvid, fid, both uid and sid, or no parameters")
    return _render_versioned_static_html("music.html")


# ── Static files (must come last) ─────────────────────────────────────────────
app.mount("/static", StaticFiles(directory="static"), name="static")


def _render_versioned_static_html(filename: str) -> HTMLResponse:
    static_root = Path("static")
    html_path = static_root / filename
    html = html_path.read_text(encoding="utf-8")

    def versioned_static_url(relative_path: str) -> str:
        asset_path = static_root / relative_path
        try:
            version = int(asset_path.stat().st_mtime)
        except FileNotFoundError:
            return f"/static/{relative_path}"
        return f"/static/{relative_path}?v={version}"

    static_url_pattern = re.compile(r'(/static/[^"\'\s?]+)(?:\?v=\d+)?')

    def rewrite_static_url(match: re.Match) -> str:
        static_url = match.group(1)
        relative_path = static_url.removeprefix("/static/")
        return versioned_static_url(relative_path)

    html = static_url_pattern.sub(rewrite_static_url, html)

    return HTMLResponse(html)


@app.get("/")
async def index():
    return _render_versioned_static_html("index.html")
