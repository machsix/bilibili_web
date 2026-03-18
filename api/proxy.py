"""
Reverse-proxy endpoints for Bilibili video/audio streams.
Passes through Range headers so seeking works correctly.
"""

import asyncio
import httpx
import os
from xml.sax.saxutils import escape
from fastapi import APIRouter, Request, HTTPException, Query
from fastapi.responses import StreamingResponse, Response, RedirectResponse

from .video import get_stream_urls, get_stream_details

_STREAM_CHUNK_SIZE = int(os.environ.get("STREAM_CHUNK_SIZE", 65536))  # bytes

router = APIRouter()

BILIBILI_HEADERS = {
    "Referer": "https://www.bilibili.com/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Origin": "https://www.bilibili.com",
}

PROXY_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


async def _proxy_stream(cdn_url: str, request: Request, force_content_type: str | None = None) -> StreamingResponse:
    """Stream a CDN URL back to the client, forwarding Range headers."""
    headers = dict(BILIBILI_HEADERS)
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header

    client = httpx.AsyncClient(timeout=PROXY_TIMEOUT, follow_redirects=True)
    try:
        upstream = await client.send(
            client.build_request("GET", cdn_url, headers=headers),
            stream=True,
        )
    except httpx.RequestError as e:
        await client.aclose()
        raise HTTPException(502, f"Upstream request failed: {e}")

    response_headers = {
        "Content-Type": force_content_type or upstream.headers.get("Content-Type", "application/octet-stream"),
        "Accept-Ranges": "bytes",
    }
    for h in ("Content-Length", "Content-Range"):
        if h in upstream.headers:
            response_headers[h] = upstream.headers[h]

    status = upstream.status_code  # 200 or 206

    async def _stream():
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=_STREAM_CHUNK_SIZE):
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(_stream(), status_code=status, headers=response_headers)


@router.get("/api/stream/video/{bvid}")
async def stream_video(bvid: str, request: Request, page: int = 0, quality: int = 1, redirect: int = 0):
    """Proxy the video track for a bilibili video."""
    try:
        urls = await get_stream_urls(bvid, page, quality)
    except Exception as e:
        raise HTTPException(500, str(e))
    if not urls.get("video_url"):
        raise HTTPException(404, "No video stream found")
    if redirect:
        return RedirectResponse(urls["video_url"], status_code=302)
    return await _proxy_stream(urls["video_url"], request)


@router.get("/api/stream/audio/{bvid}")
async def stream_audio(bvid: str, request: Request, page: int = 0, quality: int = 1, redirect: int = 0):
    """Proxy or redirect the audio track for a bilibili video.

    redirect=1: issues a 302 to the CDN URL directly — faster for capable players
                (e.g. Evermusic, VLC) that can handle CDN headers themselves.
    redirect=0 (default): proxy through this server (needed for browser CORS).
    """
    quality = max(1, int(quality))
    try:
        urls = await get_stream_urls(bvid, page, quality)
    except Exception as e:
        raise HTTPException(500, str(e))
    if not urls.get("audio_url"):
        raise HTTPException(404, "No audio stream found")
    if redirect:
        return RedirectResponse(urls["audio_url"], status_code=302)
    return await _proxy_stream(urls["audio_url"], request, force_content_type="audio/mp4")


@router.get("/api/stream/merged/{bvid}")
async def stream_merged(bvid: str, page: int = 0):
    """Mux video+audio tracks with ffmpeg on the fly.

    For DASH streams, Bilibili serves separate video-only and audio-only tracks.
    This endpoint merges them in real-time so external players (mpv, VLC) get
    a single stream with both video and audio.
    For non-DASH (mp4/flv) the single track already contains audio, so ffmpeg
    simply re-muxes into matroska with zero transcoding overhead.
    """
    try:
        urls = await get_stream_urls(bvid, page)
    except Exception as e:
        raise HTTPException(500, str(e))

    video_url = urls.get("video_url")
    audio_url = urls.get("audio_url")
    if not video_url:
        raise HTTPException(404, "No video stream found")

    # Build ffmpeg command:
    #  -i <video>  -i <audio>  (or same URL twice for non-DASH, harmless)
    #  -c copy            — no transcoding, just remux
    #  -f matroska        — streaming-friendly container
    #  pipe:1             — write to stdout
    cmd = [
        "ffmpeg", "-loglevel", "error",
        "-headers", f"Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0\r\n",
        "-i", video_url,
        "-headers", f"Referer: https://www.bilibili.com/\r\nUser-Agent: Mozilla/5.0\r\n",
        "-i", audio_url,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c", "copy",
        "-f", "matroska",
        "pipe:1",
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def _stream():
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()

    return StreamingResponse(
        _stream(),
        media_type="video/x-matroska",
        headers={"Content-Disposition": "inline"},
    )


@router.get("/api/stream/info/{bvid}")
async def stream_info(bvid: str, page: int = 0):
    """Return the stream type for the frontend to decide how to play."""
    try:
        urls = await get_stream_urls(bvid, page)
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"type": urls["type"]}


@router.get("/api/stream/mpd/{bvid}.mpd")
async def stream_mpd(bvid: str, request: Request, page: int = 0, quality: int = 2):
        """Generate a DASH MPD for Artplayer/dash.js using proxied A/V URLs."""
        try:
                details = await get_stream_details(bvid, page, quality)
        except Exception as e:
                raise HTTPException(500, str(e))

        if details.get("type") != "dash":
                raise HTTPException(409, "Current stream is not DASH")

        video_rep = details.get("video_rep") or {}
        audio_rep = details.get("audio_rep") or {}
        video_seg = video_rep.get("SegmentBase") or video_rep.get("segment_base") or {}
        audio_seg = audio_rep.get("SegmentBase") or audio_rep.get("segment_base") or {}

        video_base_url = f"/api/stream/video/{bvid}?page={page}&quality={quality}"
        audio_base_url = f"/api/stream/audio/{bvid}?page={page}&quality={quality}"

        duration_seconds = max(1.0, float(details.get("timelength") or 0) / 1000.0)

        video_mime = escape(video_rep.get("mimeType") or video_rep.get("mime_type") or "video/mp4")
        video_codecs = escape(video_rep.get("codecs") or "avc1.640028")
        video_bandwidth = int(video_rep.get("bandwidth") or 3000000)
        video_width = int(video_rep.get("width") or 1920)
        video_height = int(video_rep.get("height") or 1080)
        video_framerate = escape(str(video_rep.get("frameRate") or video_rep.get("frame_rate") or "30"))
        video_init = escape(video_seg.get("Initialization") or video_seg.get("initialization") or "0-1000")
        video_index = escape(video_seg.get("indexRange") or video_seg.get("index_range") or "1001-2000")

        audio_mime = escape(audio_rep.get("mimeType") or audio_rep.get("mime_type") or "audio/mp4")
        audio_codecs = escape(audio_rep.get("codecs") or "mp4a.40.2")
        audio_bandwidth = int(audio_rep.get("bandwidth") or 192000)
        audio_samplerate = escape(str(audio_rep.get("sampleRate") or audio_rep.get("sample_rate") or "48000"))
        audio_init = escape(audio_seg.get("Initialization") or audio_seg.get("initialization") or "0-1000")
        audio_index = escape(audio_seg.get("indexRange") or audio_seg.get("index_range") or "1001-2000")

        mpd = f"""<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\" type=\"static\" profiles=\"urn:mpeg:dash:profile:isoff-on-demand:2011\" minBufferTime=\"PT1.5S\" mediaPresentationDuration=\"PT{duration_seconds:.3f}S\">
    <Period id=\"0\" start=\"PT0S\">
        <AdaptationSet id=\"1\" contentType=\"video\" segmentAlignment=\"true\" startWithSAP=\"1\">
            <Representation id=\"video_{video_height}\" mimeType=\"{video_mime}\" codecs=\"{video_codecs}\" bandwidth=\"{video_bandwidth}\" width=\"{video_width}\" height=\"{video_height}\" frameRate=\"{video_framerate}\">
                <BaseURL>{escape(video_base_url)}</BaseURL>
                <SegmentBase indexRange=\"{video_index}\">
                    <Initialization range=\"{video_init}\" />
                </SegmentBase>
            </Representation>
        </AdaptationSet>
        <AdaptationSet id=\"2\" contentType=\"audio\" segmentAlignment=\"true\" startWithSAP=\"1\">
            <Representation id=\"audio_main\" mimeType=\"{audio_mime}\" codecs=\"{audio_codecs}\" bandwidth=\"{audio_bandwidth}\" audioSamplingRate=\"{audio_samplerate}\">
                <BaseURL>{escape(audio_base_url)}</BaseURL>
                <SegmentBase indexRange=\"{audio_index}\">
                    <Initialization range=\"{audio_init}\" />
                </SegmentBase>
            </Representation>
        </AdaptationSet>
    </Period>
</MPD>
"""

        return Response(content=mpd, media_type="application/dash+xml")


@router.get("/api/thumb")
async def proxy_thumb(url: str = Query(...)):
    """Proxy a Bilibili CDN image with the required Referer header."""
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        try:
            r = await client.get(url, headers={
                "Referer": "https://www.bilibili.com/",
                "User-Agent": BILIBILI_HEADERS["User-Agent"],
            })
        except httpx.RequestError as e:
            raise HTTPException(502, str(e))
    if r.status_code != 200:
        raise HTTPException(r.status_code, "Failed to fetch thumbnail")
    return Response(
        content=r.content,
        media_type=r.headers.get("Content-Type", "image/jpeg"),
        headers={"Cache-Control": "public, max-age=86400"},
    )
