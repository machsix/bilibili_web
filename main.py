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
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from pydantic import BaseModel

from api.playlist import get_playlist, _fetch_season, _fetch_series, _fetch_favorite
from api.video import get_video_info
from api.proxy import router as proxy_router

app = FastAPI(title="Bilibili Proxy Player")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
async def m3u_playlist(request: Request, video: int = 1, redirect: int = 0,
                       url: str = None,
                       uid: int = None, sid: int = None, fid: int = None):
    """Generate an M3U playlist for an external player (e.g. mpv, VLC).

    Parameters
    ----------
    url      : Any supported Bilibili URL (playlist, collection, favorite, video)
    uid      : Bilibili user ID (mid) — required with sid
    sid      : Season or series ID
    fid      : Favorite list ID (media_id) — alternative to uid+sid
    video    : 1 (default) → merged video+audio; 0 → audio-only
    redirect : 1 → stream URLs are CDN redirects (faster, recommended for
               mobile apps like Evermusic); 0 → proxy through this server
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
        stream_path = "merged"
        suffix = ""
    else:
        stream_path = "audio"
        suffix = "&redirect=1" if redirect else ""

    lines = ["#EXTM3U", f"# Source: {request.url}"]
    for item in items:
        bvid = item["bvid"]
        title = item.get("title", bvid)
        duration = int(item.get("duration") or 0)
        page = int(item.get("page") or 0)
        lines.append(f"#EXTINF:{duration},{title}")
        lines.append(f"{base}/api/stream/{stream_path}/{bvid}?page={page}{suffix}")

    return PlainTextResponse(
        "\n".join(lines) + "\n",
        media_type="application/x-mpegurl",
        headers={"Content-Disposition": f'attachment; filename="{label}.m3u"'},
    )


# ── Play endpoint — open web player directly ──────────────────────────────────
@app.get("/play")
async def play(uid: int = None, sid: int = None, fid: int = None, bvid: str = None):
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


# ── Static files (must come last) ─────────────────────────────────────────────
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")
