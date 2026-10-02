#!/usr/bin/env python3
"""Copies the maps folder out of an Xbox disc image, for the browser build.

The browser build (``ninja web``) reads the maps from its server, which reads
them from <data>/maps (default: assets/maps); `npm run upload-maps` puts them
there. See port/web/README.md.

Usage: python tools/extract_maps.py IMAGE [--data DIR]
"""

import argparse
import struct
import sys
from pathlib import Path

# XDVDFS, as port/linux/src/xiso.c reads it: 2048-byte sectors, a volume
# descriptor at 0x10000 in the game partition, directories as binary trees
SECTOR = 2048
VOLUME_MAGIC = b"MICROSOFT*XBOX*MEDIA"
PARTITION_OFFSETS = (0, 0x0FD90000, 0x02080000, 0x18300000)


def extract_maps(image_path: Path, destination: Path) -> None:
    """copies the maps folder out of an Xbox disc image into destination"""
    with open(image_path, "rb") as image:
        for partition in PARTITION_OFFSETS:
            image.seek(partition + 0x10000)
            descriptor = image.read(SECTOR)
            if descriptor[:20] == VOLUME_MAGIC and descriptor[0x7EC:0x7EC + 20] == VOLUME_MAGIC:
                break
        else:
            sys.exit(f"{image_path}: not an Xbox disc image")

        def directory(sector: int, size: int) -> list:
            image.seek(partition + sector * SECTOR)
            table = image.read(size)
            entries = []

            def walk(offset: int, depth: int) -> None:
                offset *= 4
                if depth > 64 or offset + 14 > len(table):
                    return
                left, right, start, length, attributes, name_length = struct.unpack_from("<HHIIBB", table, offset)
                if left == 0xFFFF:
                    return
                if left:
                    walk(left, depth + 1)
                name = table[offset + 14:offset + 14 + name_length].decode("latin-1")
                entries.append((name, start, length, bool(attributes & 0x10)))
                if right:
                    walk(right, depth + 1)

            walk(0, 0)
            return entries

        root = struct.unpack_from("<II", descriptor, 20)
        maps = next((e for e in directory(*root) if e[0].lower() == "maps" and e[3]), None)
        if not maps:
            sys.exit(f"{image_path}: no maps folder")
        partial = destination / "maps.partial"
        partial.mkdir(parents=True, exist_ok=True)
        for name, start, length, is_directory in directory(maps[1], maps[2]):
            if is_directory or "/" in name or "\\" in name or name in (".", ".."):
                continue
            print(f"  {name} ({length / 1e6:.0f} MB)")
            image.seek(partition + start * SECTOR)
            with open(partial / name, "wb") as output:
                left = length
                while left:
                    chunk = image.read(min(left, 1 << 24))
                    if not chunk:
                        sys.exit(f"{image_path}: truncated")
                    output.write(chunk)
                    left -= len(chunk)
        partial.rename(destination / "maps")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("image", type=Path, help="an Xbox disc image of the game (.xiso or .iso)")
    parser.add_argument("--data", type=Path, default=Path("assets"), help="the folder to put maps/ in (default: assets)")
    args = parser.parse_args()

    if (args.data / "maps").is_dir():
        sys.exit(f"{args.data / 'maps'} already exists")
    print(f"copying maps/ out of {args.image} into {args.data}")
    extract_maps(args.image, args.data)


if __name__ == "__main__":
    main()
