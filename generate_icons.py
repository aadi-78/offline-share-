"""
Generate Android launcher icons AND splash screen logos from assets/icon.png.

Launcher icons (mipmap-* folders, webp):
  - mdpi:    48x48 (launcher), 108x108 (foreground)
  - hdpi:    72x72 (launcher), 162x162 (foreground)
  - xhdpi:   96x96 (launcher), 216x216 (foreground)
  - xxhdpi:  144x144 (launcher), 324x324 (foreground)
  - xxxhdpi: 192x192 (launcher), 432x432 (foreground)

Splash screen logos (drawable-* folders, png):
  - mdpi:    100x100
  - hdpi:    150x150
  - xhdpi:   200x200
  - xxhdpi:  300x300
  - xxxhdpi: 400x400
"""

from PIL import Image, ImageDraw
import os

SOURCE = os.path.join("assets", "icon.png")
RES_DIR = os.path.join("android", "app", "src", "main", "res")

# ---- Launcher icon sizes ----
# density -> (launcher_size, foreground_size)
MIPMAP_DENSITIES = {
    "mipmap-mdpi":    (48,  108),
    "mipmap-hdpi":    (72,  162),
    "mipmap-xhdpi":   (96,  216),
    "mipmap-xxhdpi":  (144, 324),
    "mipmap-xxxhdpi": (192, 432),
}

# ---- Splash screen logo sizes ----
# density -> splash_logo_size
SPLASH_DENSITIES = {
    "drawable-mdpi":    100,
    "drawable-hdpi":    150,
    "drawable-xhdpi":   200,
    "drawable-xxhdpi":  300,
    "drawable-xxxhdpi": 400,
}


def make_round(img):
    """Apply a circular mask to the image."""
    size = img.size
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size[0] - 1, size[1] - 1), fill=255)
    result = Image.new("RGBA", size, (0, 0, 0, 0))
    result.paste(img, mask=mask)
    return result


def create_foreground(source_img, fg_size):
    """
    Create an adaptive icon foreground.
    The foreground canvas is larger (108dp) and the actual icon
    is placed in the center 66dp safe zone (roughly 61% of canvas).
    """
    icon_area = int(fg_size * 66 / 108)
    resized = source_img.resize((icon_area, icon_area), Image.LANCZOS)
    canvas = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
    offset = (fg_size - icon_area) // 2
    canvas.paste(resized, (offset, offset), resized if resized.mode == "RGBA" else None)
    return canvas


def generate_launcher_icons(source):
    """Generate ic_launcher.webp, ic_launcher_round.webp, ic_launcher_foreground.webp"""
    print("=== Generating Launcher Icons ===")
    for density, (launcher_size, fg_size) in MIPMAP_DENSITIES.items():
        out_dir = os.path.join(RES_DIR, density)
        os.makedirs(out_dir, exist_ok=True)

        # ic_launcher.webp
        launcher = source.resize((launcher_size, launcher_size), Image.LANCZOS)
        launcher_path = os.path.join(out_dir, "ic_launcher.webp")
        launcher.save(launcher_path, "WEBP", quality=90)
        print(f"  {launcher_path} ({launcher_size}x{launcher_size})")

        # ic_launcher_round.webp
        round_icon = make_round(launcher.copy())
        round_path = os.path.join(out_dir, "ic_launcher_round.webp")
        round_icon.save(round_path, "WEBP", quality=90)
        print(f"  {round_path} ({launcher_size}x{launcher_size} round)")

        # ic_launcher_foreground.webp
        foreground = create_foreground(source, fg_size)
        fg_path = os.path.join(out_dir, "ic_launcher_foreground.webp")
        foreground.save(fg_path, "WEBP", quality=90)
        print(f"  {fg_path} ({fg_size}x{fg_size} foreground)")


def generate_splash_icons(source):
    """Generate splashscreen_logo.png for each drawable density."""
    print("\n=== Generating Splash Screen Logos ===")
    for density, size in SPLASH_DENSITIES.items():
        out_dir = os.path.join(RES_DIR, density)
        os.makedirs(out_dir, exist_ok=True)

        splash = source.resize((size, size), Image.LANCZOS)
        splash_path = os.path.join(out_dir, "splashscreen_logo.png")
        splash.save(splash_path, "PNG")
        print(f"  {splash_path} ({size}x{size})")


def main():
    source = Image.open(SOURCE).convert("RGBA")
    print(f"Source icon: {source.size[0]}x{source.size[1]}\n")

    generate_launcher_icons(source)
    generate_splash_icons(source)

    print("\n✅ All icons and splash logos generated successfully!")


if __name__ == "__main__":
    main()
