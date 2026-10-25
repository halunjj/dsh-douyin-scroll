#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/api-comments.py —— 用签名拉某条作品/图文下的评论，列出「谁·说了什么·cid」
用途：找「号主在评论区 @ 我」的那条，拿到 cid 当 reply_id。
只读。
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str, node_bin, plugin_dir  # noqa: E402
import urllib.parse

import httpx

HOME = home_str()
# 🔴 2026-10-25 修：这两行原来是作者**本机**的绝对路径 ——
#     PLUGIN = r"D:\aiagent\deepseek\dsh-douyin-scroll"
#     NODE   = r"C:\Program Files\nodejs\node.exe"
#   换台机器必然 WinError 2（系统找不到指定的文件）⇒ sign() 失败
#   ⇒ 每一轮的高赞评论全空（证据包里 top_comments 全空就是这么来的）。
#   仓库本来就有 tools/_home.py 专门干这事，这两个文件当时漏改了。
PLUGIN = str(plugin_dir())
NODE = node_bin()
SIGNER = os.path.join(PLUGIN, "tools", "dy-signer.mjs")
COOKIE = open(os.path.join(HOME, "douyin_cookie.txt"), encoding="utf-8").read().strip()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
JAR = {}
for p in COOKIE.split(";"):
    if "=" in p:
        k, v = p.split("=", 1)
        JAR[k.strip()] = v.strip()

COMMON = {
    "device_platform": "webapp", "aid": "6383", "channel": "channel_pc_web",
    "pc_client_type": "1", "version_code": "190500", "version_name": "19.5.0",
    "cookie_enabled": "true", "screen_width": "1920", "screen_height": "1080",
    "browser_language": "zh-CN", "browser_platform": "Win32",
    "browser_name": "Chrome", "browser_version": "141.0.0.0",
    "engine_name": "Blink", "engine_version": "141.0.0.0",
    "os_name": "Windows", "os_version": "10", "platform": "PC",
}
qs = lambda d: "&".join("%s=%s" % (urllib.parse.quote(str(k)), urllib.parse.quote(str(v))) for k, v in d.items())


def sign(rel):
    env = dict(os.environ, DY_COOKIES=json.dumps(JAR, ensure_ascii=False), DOUYIN_HOME=HOME)
    p = subprocess.run([NODE, SIGNER, rel], capture_output=True, cwd=PLUGIN, env=env, timeout=240)
    out = p.stdout.decode("utf-8", "replace")
    i = out.find("{")
    if i < 0:
        return {"err": out[-300:]}
    return json.loads(out[i:out.rfind("}") + 1])


def main():
    aweme = sys.argv[1] if len(sys.argv) > 1 else "7698980229549139835"
    seen = set()
    total = 0
    for page in range(4):
        rel = "/aweme/v1/web/comment/list/?" + qs({**COMMON, "aweme_id": aweme, "count": 20, "cursor": page * 20, "item_type": 0})
        s = sign(rel)
        if s.get("err"):
            print(json.dumps({"ok": False, "err": s["err"]}, ensure_ascii=False))
            return 1
        u = s["signedUrl"]
        if not u.startswith("http"):
            u = "https://www.douyin.com" + u
        h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*", "Referer": "https://www.douyin.com/",
             "Origin": "https://www.douyin.com", "Cookie": COOKIE, **(s.get("headers") or {})}
        r = httpx.get(u, headers=h, timeout=30, follow_redirects=True)
        j = r.json()
        cs = j.get("comments") or []
        fresh = [c for c in cs if c.get("cid") not in seen]
        print("page=%d status_code=%s comments=%d 新=%d has_more=%s" % (page, j.get("status_code"), len(cs), len(fresh), j.get("has_more")))
        for c in fresh:
            seen.add(c.get("cid"))
            total += 1
            u_ = (c.get("user") or {}).get("nickname") or ""
            txt = (c.get("text") or "").replace("\n", " ")
            print("  cid=%s  %s  [%s]  赞%s  %s" % (c.get("cid"), u_, txt[:100], c.get("digg_count"), c.get("create_time")))
            for rr in (c.get("reply_comment") or [])[:6]:
                print("      └ reply cid=%s %s [%s]  %s" % (rr.get("cid"), (rr.get("user") or {}).get("nickname"),
                                                            (rr.get("text") or "").replace("\n", " ")[:90], rr.get("create_time")))
        if not fresh or not j.get("has_more"):
            break
    print("合计 %d 条" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
