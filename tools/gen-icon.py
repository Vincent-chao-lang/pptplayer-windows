#!/usr/bin/env python3
"""生成应用图标（PNG 多尺寸 + Windows .ico），纯 PIL，无需联网或额外工具。

设计：深色圆角底 + 白色幻灯片 + 红色播放三角。
在 32px 下仍然可辨——这是任务栏/文件列表里实际呈现的尺寸。
"""
import os
from PIL import Image, ImageDraw

SS = 4  # 超采样倍数，先画大图再缩，边缘才不毛
BASE = 1024
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src-tauri", "icons")

BG = (15, 19, 26, 255)        # #0f131a
SLIDE = (246, 248, 251, 255)  # #f6f8fb
ACCENT = (229, 72, 77, 255)   # #e5484d


def rounded(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)


def render():
    n = BASE * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 底：整块圆角矩形（图标本身自带圆角，Windows 不再二次裁切）
    rounded(d, (0, 0, n - 1, n - 1), int(n * 0.22), BG)

    # 幻灯片：略偏上，留出下方投影感
    x0, y0, x1, y1 = int(n * 0.175), int(n * 0.255), int(n * 0.825), int(n * 0.700)
    rounded(d, (x0, y0, x1, y1), int(n * 0.045), SLIDE)

    # 顶部红条：暗示“放映中”
    rounded(d, (x0, y0, x1, y0 + int(n * 0.075)), int(n * 0.045), ACCENT)

    # 播放三角：居中略偏下，顶点朝右
    cx, cy = n / 2, (y0 + y1) / 2 + n * 0.012
    w, h = n * 0.115, n * 0.135
    d.polygon(
        [(cx - w * 0.55, cy - h), (cx - w * 0.55, cy + h), (cx + w * 0.95, cy)],
        fill=ACCENT,
    )

    # 底座横线：让画面像“投在桌面上”
    rounded(
        d,
        (int(n * 0.30), int(n * 0.755), int(n * 0.70), int(n * 0.795)),
        int(n * 0.02),
        (60, 70, 88, 255),
    )
    return img.resize((BASE, BASE), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    icon = render()

    # Tauri 需要的几个标准 PNG
    for size, name in [(32, "32x32.png"), (128, "128x128.png"),
                       (256, "128x128@2x.png"), (512, "icon.png")]:
        icon.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))

    # Windows .ico：内含多尺寸，系统按 DPI 自动挑
    icon.save(os.path.join(OUT, "icon.ico"),
              sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                     (64, 64), (128, 128), (256, 256)])
    print("icons ->", os.path.realpath(OUT))


if __name__ == "__main__":
    main()
