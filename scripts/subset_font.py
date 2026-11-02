#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nebulove 字体子集化 & 内嵌

  pip install fonttools brotli
  
  python3 scripts/subset_font.py                     # 就地
  python3 scripts/subset_font.py --check             # 只报告，不写入
  python3 scripts/subset_font.py --all-text          # 保守模式：文件里出现的字符全收
  python3 scripts/subset_font.py --extra-chars glyphs.txt
"""
import argparse, base64, io, os, re, sys, tempfile, urllib.request
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
FONT_URL = "https://raw.githubusercontent.com/lingyicute/Nebulove/main/Nebulove.woff2"
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_HTML = os.path.join(os.path.dirname(HERE), "index.html")
ASCII = {chr(c) for c in range(32, 127)}
PUNCT = set("：，。！？；‘’“”（）【】—…·《》×＝÷＋－、")

# 匹配 @font-face 块，并连同紧邻其前的一个块注释（脚本自己生成的说明）一起吃掉，
# 保证重复运行时注释不会越积越多。
FONT_FACE_RE = re.compile(r'(?:/\*(?:[^*]|\*(?!/))*\*/\s*)?@font-face\s*\{[^}]*\}', re.S)

# 这些词之后出现的 “/” 是正则字面量的开头，而不是除号。
_REGEX_AFTER_WORDS = {"return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
                      "throw", "case", "do", "else", "yield", "await"}
_REGEX_AFTER_CHARS = set("(,=:[!&|?{};+-*%<>~^")


def _is_ident(ch):
    return ch.isalnum() or ch in "_$"


def _scan_js(src, i, in_template_expr=False):
    """扫描 JS 源码，去掉注释，保留字符串、模板字符串与正则字面量原样。

    返回 (文本, 结束位置)。这不是完整的 JS 解析器：除号与正则的区分只看前一个
    有效记号（足够覆盖常见写法）。
    """
    out, n, depth, last, word = [], len(src), 0, "", ""
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if c in "'\"":
            j = i + 1
            while j < n and src[j] != c and src[j] not in "\r\n":
                j += 2 if src[j] == "\\" else 1
            out.append(src[i:j + 1]); i = j + 1; last, word = c, ""
        elif c == "`":
            out.append(c); i += 1
            while i < n and src[i] != "`":
                if src[i] == "\\":
                    out.append(src[i:i + 2]); i += 2
                elif src.startswith("${", i):
                    out.append("${")
                    text, i = _scan_js(src, i + 2, True)
                    out.append(text)
                else:
                    out.append(src[i]); i += 1
            out.append("`"); i += 1; last, word = "`", ""
        elif c == "/" and nxt == "/":
            j = i
            while j < n and src[j] not in "\r\n":
                j += 1
            out.append(" "); i = j
        elif c == "/" and nxt == "*":
            j = src.find("*/", i + 2)
            out.append(" "); i = n if j < 0 else j + 2
        elif c == "/" and (not last or last in _REGEX_AFTER_CHARS or word in _REGEX_AFTER_WORDS):
            j, in_class = i + 1, False
            while j < n and src[j] not in "\r\n" and (in_class or src[j] != "/"):
                if src[j] == "\\":
                    j += 1
                elif src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                j += 1
            if j < n and src[j] == "/":
                out.append(src[i:j + 1]); i = j + 1; last, word = "/", ""
            else:                                  # 没有闭合：当作除号
                out.append(c); i += 1; last, word = c, ""
        else:
            if in_template_expr:
                if c == "{":
                    depth += 1
                elif c == "}":
                    if depth == 0:
                        out.append(c)
                        return "".join(out), i + 1
                    depth -= 1
            glued = i > 0 and _is_ident(src[i - 1])
            out.append(c); i += 1
            if _is_ident(c):
                word = word + c if glued and word else c
                last = c
            elif not c.isspace():
                last, word = c, ""
            elif word:
                last = word[-1]
    return "".join(out), i


def strip_js_comments(src):
    return _scan_js(src, 0)[0]


class TextParser(HTMLParser):
    """按 HTML 语法收集会进入页面的文字：忽略 HTML 注释、<style>，<script> 去掉 JS 注释。"""
    CDATA_CONTENT_ELEMENTS = (
        "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"
    )

    def __init__(self, html):
        super().__init__(convert_charrefs=False)
        self.tag, self.strip_js, self.text, self.attrs = None, False, [], []
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        if self.tag != "style":
            self.attrs.extend(v for _, v in attrs if v is not None)
        self.tag = tag
        kind = (dict(attrs).get("type") or "").strip().lower()
        self.strip_js = tag == "script" and (not kind or "javascript" in kind or kind == "module")

    def handle_endtag(self, tag):
        self.tag = None

    def handle_data(self, data):
        if self.tag == "style":
            return
        self.text.append(strip_js_comments(data) if self.tag == "script" and self.strip_js else data)

    def handle_entityref(self, name):
        self.handle_data("&" + name + ";")

    def handle_charref(self, name):
        self.handle_data("&#" + name + ";")


def strip_non_render_text(html):
    """剔除不会渲染的文字：HTML 注释、<style>、<script> 里的注释。"""
    parser = TextParser(html)
    return " ".join(parser.text + parser.attrs)


def collect_chars(html, all_text=False, extra=""):
    if all_text:
        chars = set(FONT_FACE_RE.sub('', html))
    else:
        raw = strip_non_render_text(html)
        chars = set(raw) | set(unescape(raw))
    chars |= ASCII | PUNCT | set(extra)
    chars.discard("\n")
    chars.discard("\r")
    chars.discard("\t")
    return chars


def build_subset(chars, ttf_path):
    from fontTools.ttLib import TTFont
    from fontTools.subset import Subsetter, Options

    with TTFont(ttf_path) as font:
        subsetter = Subsetter(options=Options())
        subsetter.populate(text="".join(sorted(chars)))
        subsetter.subset(font)
        font.recalcTimestamp = False   # 保留原时间戳：同样输入产出同样字节，脚本可幂等重跑
        font.flavor = "woff2"
        buf = io.BytesIO()
        font.save(buf)
        data = buf.getvalue()
        covered = set(font.getBestCmap().keys())
    return data, covered


def download(url, path):
    with urllib.request.urlopen(url, timeout=60) as r, open(path, "wb") as f:
        f.write(r.read())


def make_font_face(b64, full_kb, woff_kb, b64_kb, count, mode):
    return (
        "/* ===== Nebulove 子集（内嵌，离线可用）=====\n"
        "   由 scripts/subset_font.py 生成：只保留本页会用到的 %d 个字形（%s 模式）。\n"
        "   %.0f KB woff2 → %.1f KB woff2（base64 后 %.1f KB），随页面一起加载、无网络请求。\n"
        "   内嵌字体不可用时回退到系统字体，不发起远程请求。 ===== */\n"
        '@font-face {\n'
        "  font-family: 'Nebulove';\n"
        '  src: url("data:font/woff2;charset=utf-8;base64,%s") format("woff2");\n'
        "  font-weight: normal;\n"
        "  font-style: normal;\n"
        "  font-display: swap;\n"
        "}" % (count, mode, full_kb, woff_kb, b64_kb, b64)
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", default=DEFAULT_HTML)
    ap.add_argument("--font-url", default=FONT_URL)
    ap.add_argument("--ttf", help="本地字体路径（不下载）；默认下载 Nebulove.woff2")
    ap.add_argument("--extra-chars", help="追加字符集合所在的文本文件")
    ap.add_argument("--all-text", action="store_true", help="保守模式：文件里出现的字符全收")
    ap.add_argument("--check", action="store_true", help="只报告，不写入")
    args = ap.parse_args()

    if not os.path.exists(args.html):
        sys.exit("找不到页面文件：%s" % args.html)
    if args.ttf and not os.path.exists(args.ttf):
        sys.exit("找不到字体文件：%s" % args.ttf)
    if args.extra_chars and not os.path.exists(args.extra_chars):
        sys.exit("找不到字符文件：%s" % args.extra_chars)
    html = Path(args.html).read_text(encoding="utf-8")
    if not FONT_FACE_RE.search(html):
        sys.exit("页面里没有找到 @font-face 块，无法替换。")

    extra = ""
    if args.extra_chars:
        extra = Path(args.extra_chars).read_text(encoding="utf-8")

    chars = collect_chars(html, all_text=args.all_text, extra=extra)
    mode = "全文本" if args.all_text else "可渲染文本"
    print("需要保留的字符：%d 个（%s）" % (len(chars), mode))

    # 每次运行使用独立临时目录，避免并发覆盖或复用公共 /tmp 路径；异常也清理。
    with tempfile.TemporaryDirectory(prefix="yidoku-font-") as tmp:
        ttf = args.ttf or os.path.join(tmp, "Nebulove.woff2")
        if not args.ttf:
            print("下载完整字体：%s" % args.font_url)
            download(args.font_url, ttf)
        full_size = os.path.getsize(ttf)
        print("完整字体：%.0f KB（%s）" % (full_size / 1024, os.path.basename(ttf)))
        wofl, covered = build_subset(chars, ttf)
    missing = {c for c in chars if ord(c) not in covered}
    ratio = len(wofl) / full_size * 100 if full_size else 0
    print("子集：%.2f KB woff2（%.1f%% 于原字体）" % (len(wofl) / 1024, ratio))
    if missing:
        print("⚠️ 字体本身不含这些字符（将回退到系统字体）：%s" %
              " ".join("U+%04X" % ord(c) for c in sorted(missing)))

    if args.check:
        print("--check：不写入页面或子集文件。")
        return

    keep = os.path.join(HERE, "Nebulove-subset.woff2")
    Path(keep).write_bytes(wofl)
    print("子集文件：%s" % keep)

    b64 = base64.b64encode(wofl).decode("ascii")
    new_face = make_font_face(b64, full_size / 1024, len(wofl) / 1024, len(b64) / 1024, len(covered), mode)
    # 用函数返回替换文本，避免 re 把其中的反斜杠当作转义。
    new_html, n = FONT_FACE_RE.subn(lambda _: new_face, html, count=1)
    if new_html == html:
        print("页面已经是目标内容，未改动。")
        return
    Path(args.html).write_text(new_html, encoding="utf-8")
    print("已更新 %s（@font-face 替换 %d 处）" % (args.html, n))
    print("页面大小：%.0f KB → %.0f KB" % (len(html.encode()) / 1024, len(new_html.encode()) / 1024))


if __name__ == "__main__":
    main()
