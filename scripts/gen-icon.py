# 生成 DBFlow 图标（1024x1024，透明背景）+ 工具栏 logo（public/logo.png）
# 设计：D + F 双字母连字 —— D 镂空（半圆环碗），笔画 100 与 F 一致，
#       D 青蓝渐变 / F 黄琥珀渐变
from PIL import Image, ImageDraw

S = 4
W = 1024 * S

def s(v):
    return int(v * S)

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def diag_gradient(c1, c2):
    """对角线渐变图（左上 c1 -> 右下 c2）"""
    n = 256
    diag = Image.new("L", (n, n))
    dg = diag.load()
    for y in range(n):
        for x in range(n):
            dg[x, y] = int(255 * (x + y) / (2 * (n - 1)))
    diag = diag.resize((W, W), Image.BILINEAR)
    grad = Image.new("RGBA", (W, W), lerp(c1, c2, 0.5) + (255,))
    grad.paste(Image.new("RGBA", (W, W), c1 + (255,)), (0, 0), diag.point(lambda v: max(0, 255 - v * 2)))
    grad.paste(Image.new("RGBA", (W, W), c2 + (255,)), (0, 0), diag.point(lambda v: max(0, (v - 128) * 2)))
    return grad

top, bot = s(200), s(824)
rad = s(50)                     # 细笔画配全圆头（胶囊端）

# ---- D：竖杆 + 右碗（半圆环，环厚与笔画一致 -> 镂空腔体）----
d_x0, d_x1 = s(120), s(220)
bowl_cx = d_x1
stroke = d_x1 - d_x0            # 笔画宽 100，与 F 一致
r = (bot - top) // 2            # 外径 312
r_in = r - stroke               # 内径 212，环厚 = 100

dmask = Image.new("L", (W, W), 0)
dd = ImageDraw.Draw(dmask)
dd.rounded_rectangle([d_x0, top, d_x1, bot], radius=rad, fill=255)
# 竖杆右缘补方角，与碗的切点齐平衔接
dd.rectangle([d_x1 - rad, top, d_x1, top + rad], fill=255)
dd.rectangle([d_x1 - rad, bot - rad, d_x1, bot], fill=255)
dd.pieslice([bowl_cx - r, top, bowl_cx + r, bot], start=-90, end=90, fill=255)
bowl_cy = (top + bot) // 2
dd.pieslice([bowl_cx - r_in, bowl_cy - r_in, bowl_cx + r_in, bowl_cy + r_in], start=-90, end=90, fill=0)

# ---- F：竖杆 + 右伸两横 ----
f_x0, f_x1 = s(550), s(650)
f_arm_top_x1 = s(910)
f_arm_mid_x1 = s(860)
f_arm_top_y1 = s(300)
f_arm_mid_y0, f_arm_mid_y1 = s(465), s(565)

fmask = Image.new("L", (W, W), 0)
fd = ImageDraw.Draw(fmask)
fd.rounded_rectangle([f_x0, top, f_x1, bot], radius=rad, fill=255)
fd.rounded_rectangle([f_x0, top, f_arm_top_x1, f_arm_top_y1], radius=rad, fill=255)
fd.rounded_rectangle([f_x0, f_arm_mid_y0, f_arm_mid_x1, f_arm_mid_y1], radius=rad, fill=255)

# ---- 合成（F 后画，覆盖咬合处）----
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
img.paste(diag_gradient((34, 211, 238), (37, 99, 235)), (0, 0), dmask)   # 青 -> 蓝
img.paste(diag_gradient((253, 224, 71), (245, 158, 11)), (0, 0), fmask)  # 黄 -> 琥珀

# ---- 输出 ----
icon = img.resize((1024, 1024), Image.LANCZOS)
icon.save("design/app-icon.png")
icon.resize((128, 128), Image.LANCZOS).save("public/logo.png")           # 工具栏 logo

small = icon.resize((32, 32), Image.LANCZOS)
preview = Image.new("RGBA", (1024, 1024), (250, 250, 250, 255))
preview.paste(icon, (0, 0))
preview.paste(small, (960, 960), small)
preview.save("design/app-icon-preview.png")
print("done")
