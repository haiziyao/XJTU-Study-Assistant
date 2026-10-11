#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""联网搜索: 抓取搜索结果摘要, 注入模型上下文 (仅用标准库, 无额外依赖)。

优先使用 Bing (国内可访问), 失败后回退 DuckDuckGo HTML 端点。
抓取失败/无结果时返回空列表, 由调用方降级为常规回答。
"""

import html
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
TIMEOUT = 8
_PAGE_TIMEOUT = 6          # 抓取结果页正文的超时
_MAX_BYTES = 1024 * 1024   # 最多读取 1MB
_MAX_PAGES = 3             # 最多抓取正文的结果页数量
_PAGE_TEXT_LIMIT = 4000    # 单页正文最多保留的字符数


def _decode(data):
    for enc in ("utf-8", "gbk", "gb18030", "latin-1"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", "ignore")


def _fetch(url):
    """抓取网页。先按系统代理尝试, 失败后禁用代理直连重试。"""
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml",
    })
    last_err = None
    for no_proxy in (False, True):
        try:
            opener = (
                urllib.request.build_opener(urllib.request.ProxyHandler({}))
                if no_proxy
                else urllib.request.build_opener()
            )
            with opener.open(req, timeout=TIMEOUT) as resp:
                data = resp.read(_MAX_BYTES)
            return _decode(data)
        except Exception as e:  # noqa: BLE001
            last_err = e
            continue
    raise last_err


def _strip_tags(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _clean_url(href):
    href = html.unescape(href or "").strip()
    if href.startswith("//"):
        href = "https:" + href
    return href


def search_bing(query, count=5):
    url = ("https://www.bing.com/search?q=" + urllib.parse.quote(query)
           + "&setlang=zh-cn&count=20")
    page = _fetch(url)
    results = []
    for block in re.findall(r'<li class="b_algo".*?</li>', page, re.S):
        # 标题位于 <h2> 内的链接 (块首的 <a> 是站点图标, 需跳过)
        m = re.search(r'<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
        if not m:
            continue
        link = _clean_url(m.group(1))
        title = _strip_tags(m.group(2))
        snippet = ""
        sm = re.search(r'<p[^>]*>(.*?)</p>', block, re.S)
        if sm:
            snippet = _strip_tags(sm.group(1))
        if title and link.startswith("http"):
            results.append({"title": title, "url": link, "snippet": snippet})
        if len(results) >= count:
            break
    return results


def search_sogou(query, count=5):
    """搜狗搜索 (国内可访问, 结构较简单, 作为 Bing 的回退)。"""
    url = "https://www.sogou.com/web?query=" + urllib.parse.quote(query)
    page = _fetch(url)
    results = []
    # 标题位于 <h3> 内的链接
    for m in re.finditer(
        r'<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', page, re.S
    ):
        link = _clean_url(m.group(1))
        title = _strip_tags(m.group(2))
        if not title or not link:
            continue
        # 过滤搜狗自身的相关搜索
        if "/s?query=" in link or "as.sogou.com" in link:
            continue
        # 跳转链接补全域名, 仍可点击跳转
        if link.startswith("/link?url="):
            link = "https://www.sogou.com" + link
        if not link.startswith("http"):
            continue
        results.append({"title": title, "url": link, "snippet": ""})
        if len(results) >= count:
            break
    return results


def search_duckduckgo(query, count=5):
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    page = _fetch(url)
    results = []
    links = re.findall(
        r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', page, re.S
    )
    snippets = re.findall(
        r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>', page, re.S
    )
    for i, (href, title) in enumerate(links[:count]):
        link = _clean_url(href)
        if "duckduckgo.com/l/" in link:
            m = re.search(r"uddg=([^&]+)", link)
            if m:
                link = urllib.parse.unquote(m.group(1))
        snippet = _strip_tags(snippets[i]) if i < len(snippets) else ""
        results.append({
            "title": _strip_tags(title),
            "url": link,
            "snippet": snippet,
        })
    return results


def _dedupe(results):
    """按 URL 去重, 保留顺序。"""
    seen = set()
    out = []
    for r in results:
        url = r.get("url", "")
        if url and url in seen:
            continue
        if url:
            seen.add(url)
        out.append(r)
    return out


def web_search(query, count=5):
    """返回搜索结果列表; 失败或无结果时返回空列表。

    依次尝试 Bing → 搜狗 → DuckDuckGo, 提高成功率。
    """
    for fn in (search_bing, search_sogou, search_duckduckgo):
        try:
            results = fn(query, count)
            if results:
                return _dedupe(results)
        except Exception:  # noqa: BLE001
            continue
    return []


# ---------------------------------------------------------------------------
# 正文抓取: 打开搜索结果页, 提取正文文本, 让模型真正读到页面内容
# ---------------------------------------------------------------------------
_SKIP_TAGS = ("script", "style", "noscript", "iframe", "svg", "head")


def extract_page_text(page):
    """从 HTML 中提取可读正文文本 (去脚本/样式, 按块标签断行)。"""
    if not page:
        return ""
    # 1) 移除脚本/样式等整块
    for tag in _SKIP_TAGS:
        page = re.sub(rf"<{tag}\b[^>]*>.*?</{tag}>", " ", page, flags=re.S | re.I)
    # 2) 移除注释
    page = re.sub(r"<!--.*?-->", " ", page, flags=re.S)
    # 3) 块级标签转换行, 保留可读性
    page = re.sub(
        r"</?(?:p|br|div|li|tr|h[1-6]|section|article|ul|ol|table|blockquote)\b[^>]*>",
        "\n", page, flags=re.I,
    )
    # 4) 去掉剩余所有标签
    page = re.sub(r"<[^>]+>", " ", page)
    page = html.unescape(page)
    # 统一各类 Unicode 空白 (不间断空格等) 为普通空格
    page = re.sub(r"[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]", " ", page)
    # 5) 压缩空白, 每行修剪
    lines = [ln.strip() for ln in page.splitlines()]
    lines = [ln for ln in lines if ln]
    return "\n".join(lines)


def fetch_page_text(url):
    """抓取单个 URL 的正文文本, 失败返回空字符串。"""
    if not url or not url.startswith("http"):
        return ""
    try:
        raw = _fetch(url)
    except Exception:  # noqa: BLE001
        return ""
    text = extract_page_text(raw)
    if len(text) > _PAGE_TEXT_LIMIT:
        text = text[:_PAGE_TEXT_LIMIT] + "…"
    return text


def enrich_results(results):
    """为前 _MAX_PAGES 个结果并发抓取正文, 写入 'content' 字段。"""
    targets = [r for r in results if r.get("url", "").startswith("http")][:_MAX_PAGES]
    if not targets:
        return results

    def _fetch_one(r):
        r["content"] = fetch_page_text(r["url"])
        return r

    with ThreadPoolExecutor(max_workers=min(_MAX_PAGES, 3)) as pool:
        list(pool.map(_fetch_one, targets))
    return results


def format_results(results):
    """把搜索结果(含抓取的正文)格式化为注入 system prompt 的文本。"""
    lines = [
        "[联网搜索结果] 以下是针对用户最新问题的实时搜索结果，"
        "请优先依据下面提供的正文内容作答；若内容不足或不可靠，请如实说明。"
    ]
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. 标题: {r['title']}")
        if r.get("url"):
            lines.append(f"   链接: {r['url']}")
        if r.get("snippet"):
            lines.append(f"   摘要: {r['snippet']}")
        if r.get("content"):
            lines.append(f"   正文: {r['content']}")
    return "\n".join(lines)
