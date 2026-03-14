"""
Playlist URL parsing and video list retrieval.
Supports:
  - Favorite lists:  bilibili.com/medialist/play/ml{id}  or  ?fid={id}
  - Channel collections: space.bilibili.com/{uid}/channel/collectiondetail?sid={sid}
  - Channel series:     space.bilibili.com/{uid}/channel/seriesdetail?sid={sid}
  - New lists format:   space.bilibili.com/{uid}/lists/{sid}[?type=season]
  - Single video (multi-page BV): bilibili.com/video/BV{id}
"""

import asyncio
import re
from typing import Optional

import httpx
from bilibili_api import favorite_list, video

# Direct HTTP headers for Bilibili API calls.
_BILI_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://www.bilibili.com/",
}

_bili_client: Optional[httpx.AsyncClient] = None


async def _get_client() -> httpx.AsyncClient:
    """Return a shared httpx client with valid buvid cookies (fetched once)."""
    global _bili_client
    if _bili_client is None or _bili_client.is_closed:
        client = httpx.AsyncClient(headers=_BILI_HEADERS, follow_redirects=True, timeout=15)
        try:
            spi = await client.get("https://api.bilibili.com/x/frontend/finger/spi")
            spi_data = spi.json().get("data", {})
            client.cookies.set("buvid3", spi_data.get("b_3", ""))
            client.cookies.set("buvid4", spi_data.get("b_4", ""))
        except Exception:
            pass
        _bili_client = client
    return _bili_client


def _http_client() -> httpx.AsyncClient:
    """Legacy: create a one-off client (used for context manager usage)."""
    return httpx.AsyncClient(headers=_BILI_HEADERS, follow_redirects=True, timeout=15)


def _extract_media_id(url: str) -> Optional[int]:
    """Extract favorite list media_id from various URL formats."""
    m = re.search(r"/ml(\d+)", url)
    if m:
        return int(m.group(1))
    m = re.search(r"[?&]fid=(\d+)", url)
    if m:
        return int(m.group(1))
    return None


def _extract_collection_info(url: str):
    """Extract (uid, sid, list_type) from channel collection/series URL.

    Returns (uid, sid, 'season') or (uid, sid, 'series') or None.

    Handles both old and new URL formats:
      Old: space.bilibili.com/{uid}/channel/collectiondetail?sid={sid}  → season
           space.bilibili.com/{uid}/channel/seriesdetail?sid={sid}      → series
      New: space.bilibili.com/{uid}/lists/{sid}?type=season             → season
           space.bilibili.com/{uid}/lists/{sid}                         → series (try both)
    """
    uid_m = re.search(r"space\.bilibili\.com/(\d+)", url)
    if not uid_m:
        return None
    uid = int(uid_m.group(1))

    # New format: /lists/{sid}
    lists_m = re.search(r"/lists/(\d+)", url)
    if lists_m:
        sid = int(lists_m.group(1))
        kind = "season" if "type=season" in url else "auto"
        return uid, sid, kind

    # Old format: ?sid=
    sid_m = re.search(r"[?&]sid=(\d+)", url)
    if sid_m:
        sid = int(sid_m.group(1))
        kind = "series" if "seriesdetail" in url else "season"
        return uid, sid, kind

    return None


def _extract_bvid(url: str) -> Optional[str]:
    m = re.search(r"/video/(BV\w+)", url, re.IGNORECASE)
    return m.group(1) if m else None


def _archive_to_item(v: dict) -> dict:
    return {
        "bvid": v.get("bvid", ""),
        "title": v.get("title", ""),
        "cover": v.get("pic", ""),
        "duration": v.get("duration", 0),
        "owner": v.get("author", "") or v.get("owner", ""),
    }


async def _fetch_season(uid: int, sid: int) -> list[dict]:
    """Fetch all videos from a 合集 (season) via direct API."""
    items = []
    page_num = 1
    page_size = 30
    client = await _get_client()
    while True:
        r = await client.get(
            "https://api.bilibili.com/x/polymer/web-space/seasons_archives_list",
            params={"mid": uid, "season_id": sid, "sort_reverse": "false",
                    "page_num": page_num, "page_size": page_size},
        )
        data = r.json()
        if data.get("code") != 0:
            break
        payload = data.get("data") or {}
        archives = payload.get("archives") or []
        items.extend(_archive_to_item(a) for a in archives)
        total = (payload.get("page") or {}).get("total", 0)
        if len(items) >= total or len(archives) < page_size:
            break
        page_num += 1
        await asyncio.sleep(0.3)
    return items


async def _fetch_series(uid: int, sid: int) -> list[dict]:
    """Fetch all videos from a 系列 (series) via direct API."""
    items = []
    pn = 1
    ps = 30
    client = await _get_client()
    while True:
        r = await client.get(
            "https://api.bilibili.com/x/series/archives",
            params={"mid": uid, "series_id": sid, "only_normal": "true",
                    "sort": "asc", "pn": pn, "ps": ps},
        )
        data = r.json()
        if data.get("code") != 0:
            break
        payload = data.get("data") or {}
        archives = payload.get("archives") or []
        items.extend(_archive_to_item(a) for a in archives)
        total = (payload.get("page") or {}).get("total", 0)
        if len(items) >= total or len(archives) < ps:
            break
        pn += 1
        await asyncio.sleep(0.3)
    return items


async def _fetch_favorite(fid: int) -> list[dict]:
    """Fetch all videos from a favorite list by fid (media_id)."""
    items = []
    page = 1
    while True:
        data = await favorite_list.get_video_favorite_list_content(
            media_id=fid, page=page
        )
        medias = data.get("medias") or []
        for m in medias:
            bvid = m.get("bvid") or m.get("bv_id")
            if not bvid:
                continue
            items.append({
                "bvid": bvid,
                "title": m.get("title", ""),
                "cover": m.get("cover", ""),
                "duration": m.get("duration", 0),
                "owner": (m.get("upper") or {}).get("name", ""),
            })
        if not data.get("has_more"):
            break
        page += 1
    return items


async def get_playlist(url: str) -> list[dict]:
    """Return a list of {bvid, title, cover, duration, owner} dicts."""
    url = url.strip()

    # ── Favorite list ──────────────────────────────────────────────────────────
    media_id = _extract_media_id(url)
    if media_id:
        return await _fetch_favorite(media_id)

    # ── Channel collection / series ────────────────────────────────────────────
    col_info = _extract_collection_info(url)
    if col_info:
        uid, sid, kind = col_info

        if kind == "season":
            return await _fetch_season(uid, sid)

        if kind == "series":
            return await _fetch_series(uid, sid)

        # "auto" — no type hint, try season first then series
        items = await _fetch_season(uid, sid)
        if not items:
            items = await _fetch_series(uid, sid)
        return items

    # ── Single video (possibly multi-page) ─────────────────────────────────────
    bvid = _extract_bvid(url)
    if bvid:
        v_obj = video.Video(bvid=bvid)
        info = await v_obj.get_info()
        pages = info.get("pages", [])
        if len(pages) <= 1:
            return [{
                "bvid": bvid,
                "title": info.get("title", ""),
                "cover": info.get("pic", ""),
                "duration": info.get("duration", 0),
                "owner": (info.get("owner") or {}).get("name", ""),
                "page": 0,
            }]
        return [
            {
                "bvid": bvid,
                "title": f"{info.get('title','')} - {p.get('part', f'P{i+1}')}",
                "cover": info.get("pic", ""),
                "duration": p.get("duration", 0),
                "owner": (info.get("owner") or {}).get("name", ""),
                "page": i,
            }
            for i, p in enumerate(pages)
        ]

    raise ValueError(f"Unrecognized Bilibili URL: {url}")

