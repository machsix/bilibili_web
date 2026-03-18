"""
Video info retrieval and stream URL resolution.
"""

import time
import os
from bilibili_api.video import Video, VideoDownloadURLDataDetecter, VideoQuality, AudioQuality

# Cache resolved stream URLs for up to 1 h (Bilibili CDN URLs expire ~2 h).
_stream_cache: dict[tuple[str, int, bool], tuple[float, dict]] = {}
_STREAM_CACHE_TTL = os.environ.get("STREAM_CACHE_TTL", 3600)


async def _get_download_data(bvid: str, page: int = 0, quality: int = 2) -> dict:
    """Fetch and cache raw download metadata from Bilibili."""
    flv = (quality == 0)
    cache_key = (bvid, page, flv)
    now = time.monotonic()
    expire, download_data = _stream_cache.get(cache_key, (0, {}))
    if expire < now:
        v = Video(bvid=bvid)
        download_data = await v.get_download_url(page_index=page, html5=flv)
        _stream_cache[cache_key] = (now + float(_STREAM_CACHE_TTL), download_data)
    return download_data


def _candidate_urls(rep: dict) -> list[str]:
    """Return all possible URL fields that may appear in a DASH representation."""
    urls = []
    for key in ("baseUrl", "base_url"):
        value = rep.get(key)
        if value:
            urls.append(value)
    for key in ("backupUrl", "backup_url"):
        values = rep.get(key) or []
        urls.extend(v for v in values if v)
    return urls


def _find_dash_rep(reps: list[dict], selected_url: str | None) -> dict | None:
    """Find the DASH representation dict that matches a selected stream URL."""
    if not selected_url:
        return None
    for rep in reps:
        if selected_url in _candidate_urls(rep):
            return rep
    return None


async def get_video_info(bvid: str, page: int = 0) -> dict:
    """Return title, cover, owner, duration, pages list for a video."""
    v = Video(bvid=bvid)
    info = await v.get_info()
    return {
        "bvid": bvid,
        "title": info.get("title", ""),
        "cover": info.get("pic", ""),
        "duration": info.get("duration", 0),
        "owner": (info.get("owner") or {}).get("name", ""),
        "pages": [
            {"index": i, "part": p.get("part", f"P{i+1}"), "duration": p.get("duration", 0)}
            for i, p in enumerate(info.get("pages", []))
        ],
    }


async def get_stream_urls(bvid: str, page: int = 0, quality: int = 2) -> dict:
    """
    Resolve the best available stream URLs for a video page.

    Returns a dict with:
      - type: "dash" | "mp4" | "flv"
      - video_url: URL for video stream (None for audio-only)
      - audio_url: URL for audio stream
      - quality: quality level (0=low, 1=medium, 2=high, etc.)

    Results are cached for _STREAM_CACHE_TTL seconds to avoid redundant API calls
    (Bilibili CDN URLs are valid for ~2 h).
    """
    download_data = await _get_download_data(bvid, page, quality)

    detector = VideoDownloadURLDataDetecter(data=download_data)

    # Prefer DASH (separate video + audio tracks)
    video_max_quality = VideoQuality._4K
    audio_max_quality = AudioQuality._192K
    if quality == 1:
        video_max_quality = VideoQuality._1080P
        audio_max_quality = AudioQuality._132K
    streams = detector.detect_best_streams(
        video_max_quality=video_max_quality,
        audio_max_quality=audio_max_quality,
    )

    if streams and len(streams) >= 2:
        # DASH: streams[0] = video, streams[1] = audio
        video_stream = streams[0]
        audio_stream = streams[1]
        if hasattr(video_stream, "url") and hasattr(audio_stream, "url"):
            return {
                "type": "dash",
                "video_url": video_stream.url,
                "audio_url": audio_stream.url,
            }

    # Fallback: single-file (MP4 or FLV)
    if streams and len(streams) == 1:
        stream = streams[0]
        if hasattr(stream, "url"):
            return {
                "type": "mp4",
                "video_url": stream.url,
                "audio_url": stream.url,
            }

    # Last resort: try flv/mp4 direct
    all_streams = detector.detect_all()
    for s in all_streams:
        if hasattr(s, "url"):
            return {
                "type": "mp4",
                "video_url": s.url,
                "audio_url": s.url,
            }

    raise RuntimeError(f"Could not resolve stream URLs for {bvid} page {page}")


async def get_stream_details(bvid: str, page: int = 0, quality: int = 2) -> dict:
    """Return selected stream URLs plus DASH representation metadata when available."""
    download_data = await _get_download_data(bvid, page, quality)
    urls = await get_stream_urls(bvid, page, quality)

    details = {
        "type": urls.get("type"),
        "video_url": urls.get("video_url"),
        "audio_url": urls.get("audio_url"),
        "timelength": int(download_data.get("timelength") or 0),
        "video_rep": None,
        "audio_rep": None,
    }

    dash = download_data.get("dash") or {}
    if urls.get("type") == "dash":
        video_reps = dash.get("video") or []
        audio_reps = dash.get("audio") or []
        details["video_rep"] = _find_dash_rep(video_reps, urls.get("video_url"))
        details["audio_rep"] = _find_dash_rep(audio_reps, urls.get("audio_url"))

    return details
