"""
Video info retrieval and stream URL resolution.
"""

from bilibili_api import video as bili_video


async def get_video_info(bvid: str, page: int = 0) -> dict:
    """Return title, cover, owner, duration, pages list for a video."""
    v = bili_video.Video(bvid=bvid)
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


async def get_stream_urls(bvid: str, page: int = 0) -> dict:
    """
    Resolve the best available stream URLs for a video page.

    Returns a dict with:
      - type: "dash" | "mp4" | "flv"
      - video_url: URL for video stream (None for audio-only)
      - audio_url: URL for audio stream
    """
    v = bili_video.Video(bvid=bvid)
    download_data = await v.get_download_url(page_index=page)

    detector = bili_video.VideoDownloadURLDataDetecter(data=download_data)

    # Prefer DASH (separate video + audio tracks)
    streams = detector.detect_best_streams()

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
