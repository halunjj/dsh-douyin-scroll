#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/frames.py —— 把一条视频真的**拆成一张张图**
============================================================================
2026-10-25 新增（使用者要求：「为什么没有画面」）。

以前这个插件**故意不看画面**（README / duty.md 白纸黑字写着「不截图、不做抽帧」，
还标注"使用者定的"）。那条规矩现在改了：一条视频的文案可能只写「挑战回家不摸狗」，
笑点在哪、画面干不干净、是不是搬运，全在画面里 —— 不看画面就是瞎猜。

两条腿，分头能干、也能一起干：

  ① **封面**（永远有，零依赖）
     接口返回的 `origin_cover` 就是抖音自己抽的那一帧，直接下载，不用解码视频。
     ⇒ 没有 ffmpeg 也至少能看见一张。

  ② **真帧**（要 ffmpeg）
     下载 `play_addr` 的 mp4，按时长等距离切 N 帧（默认 3 帧、宽 640）。
     ffmpeg 不在 PATH 上也不打紧 —— 按这个顺序找：
       `DOUYIN_FFMPEG` 环境变量 → venv 里的 imageio-ffmpeg → PATH 上的 ffmpeg
       → 都没有就 `pip install imageio-ffmpeg`（约 31MB 静态二进制，装一次长期用）

⚠️ stdout **只出 JSON**（调用方直接 pickJson 解析）；人看的提示一律走 stderr。

用法:
  python tools/frames.py --aweme 7300000000000000000              # 封面 + 3 帧
  python tools/frames.py --aweme <id> --frames 5 --width 720
  python tools/frames.py --aweme <id> --cover-only                # 只要封面（不碰 ffmpeg）
  python tools/frames.py --list                                   # 看家目录里已经抽过哪些
  python tools/frames.py --aweme <id> --clean                     # 删掉这条的缓存视频和旧图

输出:
  <家目录>/frames/<aweme_id>/cover.jpg, frame-1.jpg … frame-N.jpg
  <家目录>/frames/index.json   （每条一条记录，方便别的脚本直接读路径）
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str  # noqa: E402

from curl_cffi import requests as creq  # noqa: E402

# Windows 上 stdout 默认 GBK，标题里的 emoji / 数学字母会把打印弄崩 —— 强制 utf-8
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HOME = home_str()
PICK_JSON = os.path.join(HOME, "forward-pick.json")
FRAME_ROOT = os.path.join(HOME, "frames")
INDEX_JSON = os.path.join(FRAME_ROOT, "index.json")
CACHE_DIR = os.path.join(HOME, "cache", "video")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
REFERER = "https://www.douyin.com/"

DEFAULT_FRAMES = 3
DEFAULT_WIDTH = 640
JPEG_QUALITY = 4          # ffmpeg -q:v：2 最好 31 最差，4 在 640 宽下已经够看清


def note(msg):
    """人看的提示 —— 只走 stderr，别污染 stdout 的 JSON。"""
    print(msg, file=sys.stderr)


def load_cookie():
    p = os.path.join(HOME, "douyin_cookie.txt")
    try:
        with open(p, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def load_pick():
    try:
        with open(PICK_JSON, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def find_row(aweme_id):
    """从候选清单里找这一条（只有清单里的条目才有 play_url / cover_url）。"""
    picked = load_pick()
    rows = picked.get("rows") if isinstance(picked, dict) else None
    for r in (rows or []):
        if str(r.get("aweme_id")) == str(aweme_id):
            return r
    return None


def http_get_bytes(url, cookie, timeout=60):
    """下载一个二进制资源（封面 / 视频）。返回 (bytes, err)。"""
    if not url:
        return None, "没有地址"
    try:
        with creq.Session(impersonate="chrome") as s:
            s.headers.update({
                "User-Agent": UA,
                "Cookie": cookie or "",
                "Referer": REFERER,
                "Accept": "*/*",
            })
            r = s.get(url, timeout=timeout)
            if r.status_code != 200:
                return None, "HTTP %s" % r.status_code
            body = r.content
            if not body:
                return None, "空响应"
            return body, ""
    except Exception as e:
        return None, str(e)[:200]


def is_jpeg(b):
    return bool(b) and len(b) > 512 and b[:2] == b"\xff\xd8"


def find_ffmpeg(allow_install=True):
    """
    找 ffmpeg。返回 (路径, 来源)；找不到返回 ("", "missing")。
    ⚠️ 装包那一步的输出**绝不能进 stdout**（那会毁掉 JSON），全部吞掉。
    """
    env = (os.environ.get("DOUYIN_FFMPEG") or "").strip()
    if env and os.path.exists(env):
        return env, "DOUYIN_FFMPEG"
    try:
        import imageio_ffmpeg  # type: ignore
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.exists(p):
            return p, "imageio-ffmpeg"
    except Exception:
        pass
    p = shutil.which("ffmpeg")
    if p:
        return p, "PATH"
    if allow_install:
        note("· 没找到 ffmpeg，正在装 imageio-ffmpeg（约 31MB，一次装好长期用）…")
        try:
            r = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "imageio-ffmpeg"],
                capture_output=True, text=True, timeout=900,
            )
            if r.returncode != 0:
                note("· 装 imageio-ffmpeg 失败：" + (r.stderr or "")[-300:])
                return "", "missing"
        except Exception as e:
            note("· 装 imageio-ffmpeg 抛错：%s" % e)
            return "", "missing"
        try:
            import imageio_ffmpeg  # type: ignore
            p = imageio_ffmpeg.get_ffmpeg_exe()
            if p and os.path.exists(p):
                return p, "pip-installed"
        except Exception as e:
            note("· 装完还是 import 不进来：%s" % e)
    return "", "missing"


def probe_duration(ffmpeg, video):
    """没有 ffprobe（imageio-ffmpeg 只带 ffmpeg）—— 从 `ffmpeg -i` 的 stderr 里抠 Duration。"""
    try:
        r = subprocess.run([ffmpeg, "-hide_banner", "-i", video],
                           capture_output=True, text=True, timeout=60)
        text = (r.stderr or "") + (r.stdout or "")
        for line in text.splitlines():
            if "Duration:" in line:
                frag = line.split("Duration:")[1].split(",")[0].strip()
                h, m, s = frag.split(":")
                return float(h) * 3600 + float(m) * 60 + float(s)
    except Exception:
        pass
    return 0.0


def grab_frame(ffmpeg, video, out_path, at_s, width):
    """切一帧。返回 (ok, err)。"""
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error",
           "-ss", "%.2f" % max(0.0, at_s), "-i", video,
           "-frames:v", "1", "-vf", "scale=%d:-2" % width,
           "-q:v", str(JPEG_QUALITY), "-y", out_path]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return False, (r.stderr or "").strip()[-200:]
    except Exception as e:
        return False, str(e)[:200]
    try:
        if os.path.exists(out_path) and os.path.getsize(out_path) > 512:
            return True, ""
    except Exception:
        pass
    return False, "没产出文件（那个时间点可能没关键帧）"


def frame_times(duration, n):
    """
    按时长等距离取 n 个时间点 —— **避开头和尾**：
    开头常是黑场/logo，结尾常是"关注我"的贴片，中间才是内容。
    """
    if duration and duration > 1.0:
        d = duration
    else:
        d = 15.0            # 不知道时长：按短视频中位数猜（宁可按 15 秒切也别放弃）
    return [round(d * (i + 1.0) / (n + 1.0), 2) for i in range(n)]


def write_index(rec):
    """往 frames/index.json 里记一条（同一个 aweme_id 覆盖）。"""
    try:
        os.makedirs(FRAME_ROOT, exist_ok=True)
        data = {}
        if os.path.exists(INDEX_JSON):
            try:
                with open(INDEX_JSON, "r", encoding="utf-8") as f:
                    data = json.load(f) or {}
            except Exception:
                data = {}
        if not isinstance(data, dict):
            data = {}
        data[str(rec.get("aweme_id") or "")] = rec
        with open(INDEX_JSON, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    except Exception as e:
        note("· 写 index.json 失败（不影响出图）：%s" % e)


def clean_one(aweme_id):
    """删掉这一条的帧目录 + 缓存视频。"""
    removed = []
    d = os.path.join(FRAME_ROOT, str(aweme_id))
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)
        removed.append(d)
    for f in glob.glob(os.path.join(CACHE_DIR, "%s.*" % aweme_id)):
        try:
            os.remove(f)
            removed.append(f)
        except Exception:
            pass
    return removed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aweme", help="作品 ID（要先在 forward-pick.json 的候选清单里）")
    ap.add_argument("--frames", type=int, default=DEFAULT_FRAMES, help="抽几帧（默认 3，0 = 只封面）")
    ap.add_argument("--width", type=int, default=DEFAULT_WIDTH, help="输出宽度（默认 640，等比缩放）")
    ap.add_argument("--cover-only", action="store_true", help="只要封面，不碰 ffmpeg / 不下视频")
    ap.add_argument("--no-cover", action="store_true", help="不要封面")
    ap.add_argument("--keep-video", action="store_true", help="保留下载的 mp4（默认也留在 cache 里复用）")
    ap.add_argument("--clean", action="store_true", help="删掉这条的图 + 缓存视频，不抽帧")
    ap.add_argument("--cover-url", help="直接给封面地址（不在候选清单里时用）")
    ap.add_argument("--play-url", help="直接给视频地址（不在候选清单里时用）")
    ap.add_argument("--list", action="store_true", help="列出已经抽过图的 aweme_id")
    args = ap.parse_args()

    if args.list:
        try:
            with open(INDEX_JSON, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
        except Exception:
            data = {}
        out = {"ok": True, "root": FRAME_ROOT, "items": [
            {"aweme_id": k, "dir": v.get("dir"), "frames": len(v.get("frames") or []), "at": v.get("at")}
            for k, v in sorted(data.items())
        ]}
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0

    aweme_id = str(args.aweme or "").strip()
    if not aweme_id:
        print(json.dumps({"ok": False, "error": "缺 --aweme"}, ensure_ascii=False))
        return 2

    if args.clean:
        removed = clean_one(aweme_id)
        print(json.dumps({"ok": True, "aweme_id": aweme_id, "removed": removed}, ensure_ascii=False, indent=1))
        return 0

    row = find_row(aweme_id) or {}
    cover_url = args.cover_url or row.get("cover_url") or ""
    play_url = args.play_url or row.get("play_url") or ""
    duration = row.get("duration_s") or 0
    try:
        duration = float(duration or 0)
    except Exception:
        duration = 0.0

    warnings = []
    if not cover_url and not play_url:
        msg = ("候选清单里没有这条（%s），也没有给 --cover-url/--play-url ⇒ 拿不到画面。"
               "先跑 forward-pick.py 把候选拉出来。" % aweme_id)
        print(json.dumps({"ok": False, "aweme_id": aweme_id, "error": msg,
                          "hint": "forward-pick.json 里 rows[].cover_url / play_url 是画面入口"},
                         ensure_ascii=False, indent=1))
        return 1

    out_dir = os.path.join(FRAME_ROOT, aweme_id)
    os.makedirs(out_dir, exist_ok=True)
    cookie = load_cookie()

    frames = []

    # ── ① 封面（零依赖，先拿到手再说） ──
    if cover_url and not args.no_cover:
        body, err = http_get_bytes(cover_url, cookie, timeout=40)
        if body and is_jpeg(body):
            p = os.path.join(out_dir, "cover.jpg")
            with open(p, "wb") as f:
                f.write(body)
            frames.append({"idx": 0, "kind": "cover", "path": p, "bytes": len(body), "at_s": None})
            note("· 封面 ✓ %d 字节" % len(body))
        else:
            # 有些封面是 webp（dynamic_cover 就是动图）—— 存下来，别假装是 jpg
            if body:
                ext = ".webp" if body[:4] == b"RIFF" else ".bin"
                p = os.path.join(out_dir, "cover" + ext)
                with open(p, "wb") as f:
                    f.write(body)
                frames.append({"idx": 0, "kind": "cover", "path": p, "bytes": len(body), "at_s": None,
                               "note": "非 JPEG（%s），视觉模型多半也认" % ext.lstrip(".")})
                note("· 封面 ✓ （%s）%d 字节" % (ext, len(body)))
            else:
                warnings.append("封面下载失败：%s" % err)
                note("· 封面 ✗ %s" % err)

    # ── ② 真帧 ──
    want = 0 if args.cover_only else max(0, min(int(args.frames or 0), 12))
    if want and play_url:
        ffmpeg, src = find_ffmpeg()
        if not ffmpeg:
            warnings.append("没有 ffmpeg ⇒ 只拿到封面。装它：venv 里 pip install imageio-ffmpeg，"
                            "或设 DOUYIN_FFMPEG 指向 ffmpeg.exe")
            note("· 没有 ffmpeg，跳过抽帧（封面还在）")
        else:
            note("· ffmpeg: %s（%s）" % (ffmpeg, src))
            os.makedirs(CACHE_DIR, exist_ok=True)
            video = os.path.join(CACHE_DIR, "%s.mp4" % aweme_id)
            need_dl = (not os.path.exists(video)) or os.path.getsize(video) < 4096
            if need_dl:
                note("· 下载视频…")
                body, err = http_get_bytes(play_url, cookie, timeout=180)
                if not body or len(body) < 4096:
                    warnings.append("视频下载失败：%s（只拿到封面）" % err)
                    note("· 视频 ✗ %s" % err)
                else:
                    with open(video, "wb") as f:
                        f.write(body)
                    note("· 视频 ✓ %.1f MB" % (len(body) / 1048576.0))
            if os.path.exists(video) and os.path.getsize(video) >= 4096:
                if not duration:
                    duration = probe_duration(ffmpeg, video)
                times = frame_times(duration, want)
                note("· 时长 %.1fs → 切 %s" % (duration or 0, times))
                for i, t in enumerate(times, 1):
                    p = os.path.join(out_dir, "frame-%d.jpg" % i)
                    ok, err = grab_frame(ffmpeg, video, p, t, max(120, min(int(args.width or 0), 1600)))
                    if ok:
                        frames.append({"idx": i, "kind": "video", "path": p,
                                       "bytes": os.path.getsize(p), "at_s": t})
                        note("  frame-%d ✓ @%ss" % (i, t))
                    else:
                        warnings.append("第 %d 帧（@%ss）没切出来：%s" % (i, t, err))
                        note("  frame-%d ✗ %s" % (i, err))
            if not args.keep_video and os.path.exists(video):
                pass          # 默认**留着**：同一轮里再抽别的帧不用重下（--clean 才删）
    elif want and not play_url:
        warnings.append("候选里没有 play_addr（这条可能被限流/是图集）⇒ 只有封面")

    rec = {
        "ok": True,
        "aweme_id": aweme_id,
        "dir": out_dir,
        "desc": (row.get("desc") or "")[:120],
        "author": row.get("author") or "",
        "duration_s": duration or None,
        "cover_url": bool(cover_url),
        "play_url": bool(play_url),
        "frames": frames,
        "warnings": warnings,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    write_index(rec)
    print(json.dumps(rec, ensure_ascii=False, indent=1))
    return 0 if frames else 1


if __name__ == "__main__":
    sys.exit(main())