#!/usr/bin/env python3
"""Serves the browser build (``ninja web``) and the game data on localhost.

The page needs two things a plain file server does not give:

- cross-origin isolation (the COOP and COEP headers), without which the
  browser gives a page no shared memory and so no threads;
- HTTP range requests, with which the game reads the maps a chunk at a
  time (port/web/src/web_main.c).

The maps are read from <data>/maps (default: assets/maps). With --xiso, they
are first copied out of an Xbox disc image if that folder has none.

Usage: python tools/web_serve.py [--xiso IMAGE] [--data DIR] [--port PORT]
"""

import argparse
import http.server
import os
import re
import struct
import sys
from pathlib import Path

BUILD_DIR = Path("build/web")
TYPES = {".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm"}

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


class Handler(http.server.SimpleHTTPRequestHandler):
    data_dir = Path("assets")

    def translate(self):
        path = self.path.split("?", 1)[0]
        path = re.sub(r"/+", "/", path)
        if path.startswith("/maps/"):
            base, rest = self.data_dir / "maps", path[len("/maps/"):]
        else:
            base, rest = BUILD_DIR, path.lstrip("/") or "halo.html"
        target = (base / rest).resolve()
        if base.resolve() not in target.parents:
            return None
        return target

    def send_file(self, head: bool) -> None:
        target = self.translate()
        if not target or not target.is_file():
            self.send_error(404)
            return
        size = target.stat().st_size
        match = re.match(r"bytes=(\d+)-(\d*)$", self.headers.get("Range", ""))
        start, end = 0, size - 1
        if match:
            start = int(match.group(1))
            end = min(int(match.group(2)), size - 1) if match.group(2) else size - 1
            if start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", TYPES.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if head:
            return
        with open(target, "rb") as file:
            file.seek(start)
            left = end - start + 1
            while left:
                chunk = file.read(min(left, 1 << 20))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(chunk)

    def do_GET(self):
        self.send_file(head=False)

    def do_HEAD(self):
        self.send_file(head=True)

    def log_message(self, format, *args):
        if os.environ.get("HALO_WEB_SERVE_LOG"):
            super().log_message(format, *args)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, default=Path("assets"), help="the folder that holds maps/ (default: assets)")
    parser.add_argument("--xiso", type=Path, help="an Xbox disc image to copy maps/ out of, if the data folder has none")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    if not (BUILD_DIR / "halo.html").is_file():
        sys.exit("build/web/halo.html is missing: run `python configure.py` and `ninja web` first")
    if not (args.data / "maps").is_dir():
        if not args.xiso:
            sys.exit(f"{args.data / 'maps'} is missing: give --xiso with your Xbox disc image to copy it out")
        print(f"copying maps/ out of {args.xiso} into {args.data}")
        extract_maps(args.xiso, args.data)
    Handler.data_dir = args.data
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"serving the browser build on http://localhost:{args.port}/ (Ctrl+C stops)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
