#!/usr/bin/env python3
"""Render a terminal-style demo video (MP4) from a captured log — no screen-recording permissions needed.

Why this exists: the demo for Aevum Builder Challenge #1 has to show a REAL payment, but recording a desktop session
is fragile (permissions, window sizes, whatever is on screen). This renders exactly the captured bytes of a real run
onto a dark terminal canvas with a title card, an optional still (e.g. a screenshot of the explorer transaction page),
and an end card, then encodes with ffmpeg.

Usage:
  python3 packages/x402/scripts/render-demo-video.py \
      --input docs/qday/media/l1-fork-capture.txt \
      --title "MoneySwitch × QDay Aevum — tUSD8 x402 payment" \
      --subtitle "L1: the whole loop on an anvil fork of the real chain (no faucet)" \
      --endcard "4 verification layers · 28/28 contract tests · docs/qday/" \
      --out docs/qday/media/demo-l1-fork.mp4 \
      [--still path/to/explorer.png --still-caption "explorer-test.qday.info/tx/0x…"]

`--still` / `--still-caption` are repeatable PAIRS, shown in the order given, each held for `--still-hold` seconds
(default 4). One still behaves exactly as before; a missing/unreadable still is warned about and skipped:

  ... --still bills.png --still-caption "dashboard · bills" \
      --still keys.png  --still-caption "dashboard · API keys" \
      --still tx.png    --still-caption "explorer · the settlement tx"

Lines starting with `#> ` are drawn as typed commands (green); lines containing `✔` are highlighted amber.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 800
MARGIN = 44
LINE_H = 27
FPS = 12

BG = (13, 17, 23)
CHROME_BG = (22, 27, 34)
PROMPT = (126, 231, 135)
TEXT = (230, 237, 243)
HIGHLIGHT = (240, 180, 41)
DIM = (139, 148, 158)
WHITE = (255, 255, 255)

FONT_PATH = "/System/Library/Fonts/Menlo.ttc"
# Menlo has no CJK glyphs (they render as tofu); Hiragino Sans GB covers them, so text picks its font by content.
CJK_FONT_PATH = "/System/Library/Fonts/Hiragino Sans GB.ttc"
CJK = re.compile(r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]")


def font(size: int, text: str = "") -> ImageFont.FreeTypeFont:
    wants_cjk = bool(CJK.search(text))
    for path in ((CJK_FONT_PATH,) if wants_cjk else ()) + (FONT_PATH, "/System/Library/Fonts/SFNSMono.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    raise SystemExit("no font found (looked for Menlo / SF Mono / Hiragino Sans GB)")


def _chunks(draw: ImageDraw.ImageDraw, word: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    """Split a token that is wider than the canvas (a JSON blob, a tx hash) so nothing runs off the edge."""
    out, current = [], ""
    for ch in word:
        if draw.textlength(current + ch, font=f) <= width:
            current += ch
        else:
            out.append(current)
            current = ch
    if current:
        out.append(current)
    return out


def wrap(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    words, lines, current = text.split(" "), [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textlength(candidate, font=f) <= width:
            current = candidate
            continue
        if current:
            lines.append(current)
        if draw.textlength(word, font=f) > width:
            pieces = _chunks(draw, word, f, width)
            lines.extend(pieces[:-1])
            current = pieces[-1]
        else:
            current = word
    lines.append(current)
    return lines


@dataclass
class Style:
    color: tuple[int, int, int]
    bold: bool = False


def style_for(line: str) -> Style:
    if line.startswith("#>"):
        return Style(PROMPT, bold=True)
    if "✔" in line or "PASS" in line:
        return Style(HIGHLIGHT, bold=True)
    if line.startswith("▶") or line.startswith("───"):
        return Style(DIM)
    return Style(TEXT)


def terminal_frame(lines: list[str], cursor: bool, f: ImageFont.FreeTypeFont, fb: ImageFont.FreeTypeFont) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # window chrome
    d.rectangle([0, 0, W, 34], fill=CHROME_BG)
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([16 + i * 22, 11, 28 + i * 22, 23], fill=color)
    d.text((100, 8), "MoneySwitch · QDay Aevum testnet", font=f, fill=DIM)

    # Wrap everything first, then keep the newest lines that fit — a terminal scrolls, it never drops the tail.
    rendered: list[tuple[str, Style, ImageFont.FreeTypeFont]] = []
    for line in lines:
        style = style_for(line)
        chosen = font(19, line)  # font() already switches to the CJK face when the text needs it
        for piece in wrap(d, line, chosen, W - 2 * MARGIN):
            rendered.append((piece, style, chosen))
    capacity = (H - 56 - MARGIN) // LINE_H
    visible = rendered[-capacity:]

    y = 56
    for piece, style, chosen in visible:
        d.text((MARGIN, y), piece, font=chosen, fill=style.color)
        y += LINE_H
    if cursor:
        d.rectangle([MARGIN, y + 2, MARGIN + 11, y + LINE_H - 4], fill=PROMPT)
    return img


def card(title: str, subtitle: str, footer: str = "") -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    ft, fs, ff = font(40, title), font(21, subtitle), font(16, footer)
    y = H // 2 - 90
    for line in wrap(d, title, ft, W - 2 * MARGIN):
        d.text((MARGIN, y), line, font=ft, fill=WHITE)
        y += 52
    y += 18
    for line in wrap(d, subtitle, fs, W - 2 * MARGIN):
        d.text((MARGIN, y), line, font=fs, fill=HIGHLIGHT)
        y += 32
    if footer:
        y += 24
        for line in wrap(d, footer, ff, W - 2 * MARGIN):
            d.text((MARGIN, y), line, font=ff, fill=DIM)
            y += 24
    d.text((MARGIN, H - 56), "moneyswitch.dev  ·  github.com/dongsheng123132/moneyswitch", font=ff, fill=DIM)
    return img


def still(path: Path, caption: str) -> Image.Image:
    shot = Image.open(path).convert("RGB")
    shot.thumbnail((W - 2 * MARGIN, H - 160))
    img = Image.new("RGB", (W, H), BG)
    img.paste(shot, ((W - shot.width) // 2, 110))
    d = ImageDraw.Draw(img)
    d.text((MARGIN, 52), caption, font=font(18), fill=HIGHLIGHT)
    return img


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="captured log; '#> ' prefixes a typed command")
    ap.add_argument("--title", default="MoneySwitch × QDay Aevum")
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--endcard", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument(
        "--still",
        action="append",
        default=None,
        metavar="PATH",
        help="screenshot inserted before the end card; repeat for several (paired with --still-caption)",
    )
    ap.add_argument(
        "--still-caption",
        action="append",
        default=None,
        metavar="TEXT",
        help="caption for the preceding --still; repeat in the same order",
    )
    ap.add_argument("--still-hold", type=float, default=4.0, help="seconds each still is held")
    ap.add_argument("--line-hold", type=float, default=0.42, help="seconds each new line waits")
    args = ap.parse_args()

    f, fb = font(19), font(19)
    lines = [l.rstrip() for l in Path(args.input).read_text(encoding="utf-8").splitlines() if l.strip()]

    tmp = Path(tempfile.mkdtemp(prefix="qday-video-"))
    frame_no = 0

    def emit(img: Image.Image, hold_frames: int) -> None:
        nonlocal frame_no
        for _ in range(max(1, hold_frames)):
            img.save(tmp / f"f{frame_no:05d}.png")
            frame_no += 1

    emit(card(args.title, args.subtitle, "a real EIP-3009 settlement in tUSD8"), FPS * 3)
    for n in range(1, len(lines) + 1):
        emit(terminal_frame(lines[:n], cursor=n < len(lines), f=f, fb=fb), max(1, round(args.line_hold * FPS)))
    emit(terminal_frame(lines, cursor=False, f=f, fb=fb), FPS * 3)
    stills = args.still or []
    captions = args.still_caption or []
    still_frames = max(1, round(args.still_hold * FPS))
    for i, raw in enumerate(stills):
        path = Path(raw)
        # A still is decoration: a missing file must never kill a render that already has real captured output.
        if not path.is_file():
            print(f"warning: skipping still (not found): {raw}", file=sys.stderr)
            continue
        caption = captions[i] if i < len(captions) and captions[i] else raw
        try:
            img = still(path, caption)
        except Exception as exc:  # unreadable / not an image / truncated download
            print(f"warning: skipping still {raw} ({exc})", file=sys.stderr)
            continue
        emit(img, still_frames)
    emit(card("Done", args.endcard or "every layer verified", "docs/qday/README.md"), FPS * 3)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS),
        "-i", str(tmp / "f%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", args.out,
    ]
    subprocess.run(cmd, check=True)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"{args.out}  ({frame_no} frames, {frame_no / FPS:.1f}s)")


if __name__ == "__main__":
    main()
