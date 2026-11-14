"""Cut every project screenshot to one 16:10 frame (720x450) for the project cards on the site and in the profile README.

Usage: python tools/thumbs.py <folder with source images>
Source files are named after the repo (moon-rover.jpg, ...). Output: assets/p/<repo>.jpg
"""
import os, sys
from PIL import Image

W, H = 720, 450
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'p')

# mode 'crop' fills the frame (fx, fy = focus point 0..1); 'fit' letterboxes on the image's own corner colour
SPEC = {
    'spiralist.jpg': ('crop', .5, .5),
    'typist.png': ('fit',),
    'credits-cubed.png': ('fit',),
    'mosaiz.png': ('fit',),
    'idea-to-build.png': ('fit',),
    'x-ghostwriter.png': ('fit',),
    'mc-print-3d.png': ('crop', .62, .4),
    'cut.jpg': ('crop', .5, .0),
    'seedplot.png': ('tiles',),
    'follower-sweep.png': ('crop', .5, .0),
    'zodiac-z13-z32.png': ('crop', .5, .0),
    'winchxyz.github.io.png': ('crop', .3, .4),
}
SKIP = {'spiralist.png'}


def crop(im, fx, fy):
    w, h = im.size
    if w / h > W / H:
        cw, ch = round(h * W / H), h
    else:
        cw, ch = w, round(w * H / W)
    x = round((w - cw) * fx)
    y = round((h - ch) * fy)
    return im.crop((x, y, x + cw, y + ch)).resize((W, H), Image.LANCZOS)


def fit(im, pad=24):
    bg = im.getpixel((2, 2))
    im = im.copy()
    im.thumbnail((W - 2 * pad, H - 2 * pad), Image.LANCZOS)
    out = Image.new('RGB', (W, H), bg)
    out.paste(im, ((W - im.width) // 2, (H - im.height) // 2))
    return out


def tiles(im):
    # seedplot: a strip of five styles -> 3 on top, 2 below
    n = 5
    tw = im.width // n
    parts = [im.crop((i * tw, 0, (i + 1) * tw, im.height)) for i in range(n)]
    bg = im.getpixel((2, 2))
    size = 196
    gap = 14
    out = Image.new('RGB', (W, H), bg)
    rows = [parts[:3], parts[3:]]
    y = (H - 2 * size - gap) // 2
    for row in rows:
        x = (W - len(row) * size - (len(row) - 1) * gap) // 2
        for p in row:
            p = p.copy()
            p.thumbnail((size, size), Image.LANCZOS)
            out.paste(p, (x + (size - p.width) // 2, y + (size - p.height) // 2))
            x += size + gap
        y += size + gap
    return out


def main(src):
    os.makedirs(OUT, exist_ok=True)
    for f in sorted(os.listdir(src)):
        if f in SKIP:
            continue
        im = Image.open(os.path.join(src, f)).convert('RGB')
        mode = SPEC.get(f, ('crop', .5, .5))
        if mode[0] == 'crop':
            t = crop(im, mode[1], mode[2])
        elif mode[0] == 'fit':
            t = fit(im)
        else:
            t = tiles(im)
        name = os.path.splitext(f)[0] + '.jpg'
        t.save(os.path.join(OUT, name), quality=84, optimize=True, progressive=True)
        print(name, os.path.getsize(os.path.join(OUT, name)) // 1024, 'KB')


if __name__ == '__main__':
    main(sys.argv[1])
