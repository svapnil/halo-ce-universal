#!/usr/bin/env python3
"""Lists internet play's public games, by network version, from the brokers.

A public game's host keeps a listing of it retained on every broker of
port/assets/network/brokers.txt, in its slot hceu/3/lobby/s/<key hash>
(port/linux/src/p2p_lobby.c). This subscribes to the slots and prints what
the listings say: each version's games and players, so that one can see
where the players are (the server browser shows only its own version's).
It only reads: it publishes nothing, not even the lobby's query.

It does not check the listings' signatures (the game does), and the counts
are what each host says. Games joined only by invite, and browser rooms
(port/web/NETWORK.md), are never listed on the brokers.

Usage: python tools/lobby_list.py [--seconds N] [--brokers FILE] [--all]
"""

import argparse
import collections
import os
import socket
import struct
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BROKERS_FILE = ROOT / "port" / "assets" / "network" / "brokers.txt"
SLOTS_TOPIC = "hceu/3/lobby/s/+"

# the listing (p2p_lobby.c): "HL", format 1, version (2), flags, sequence (4),
# time (4), key (32), token (16; 56 sealed), players, most players, engine,
# then the name, map and gametype (a length byte each), a stamp, a signature
LISTING_FORMAT = 1
KEY_SIZE = 32
TOKEN_SIZE = 16
SEALED_TOKEN_SIZE = 56
FLAG_OPEN = 1
FLAG_IN_PROGRESS = 2
FLAG_CLOSED = 8
FLAG_PASSWORD = 16
# a retained listing older than this is a host that died and left it
STALE_SECONDS = 600


def read_brokers(path: Path) -> list:
    """the host:port lines of a brokers file, without its comments"""
    brokers = []
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            brokers.append(line)
    return brokers


def mqtt_length(length: int) -> bytes:
    encoded = b""
    while True:
        byte = length % 128
        length //= 128
        encoded += bytes([byte | (0x80 if length else 0)])
        if not length:
            return encoded


def mqtt_string(text: str) -> bytes:
    data = text.encode()
    return struct.pack(">H", len(data)) + data


def receive_exactly(connection: socket.socket, size: int) -> bytes:
    data = b""
    while len(data) < size:
        chunk = connection.recv(size - len(data))
        if not chunk:
            raise EOFError("the broker closed the connection")
        data += chunk
    return data


def receive_packet(connection: socket.socket) -> tuple:
    header = receive_exactly(connection, 1)[0]
    length, multiplier = 0, 1
    while True:
        byte = receive_exactly(connection, 1)[0]
        length += (byte & 127) * multiplier
        multiplier *= 128
        if not byte & 128:
            break
    return header, receive_exactly(connection, length)


def parse_listing(payload: bytes):
    """a listing's fields, or None if it is not one"""
    try:
        if payload[:2] != b"HL" or payload[2] != LISTING_FORMAT:
            return None
        offset = 3
        version = payload[offset] << 8 | payload[offset + 1]
        offset += 2
        flags = payload[offset]
        offset += 1
        sequence, listed_time = struct.unpack(">II", payload[offset:offset + 8])
        offset += 8 + KEY_SIZE
        offset += SEALED_TOKEN_SIZE if flags & FLAG_PASSWORD else TOKEN_SIZE
        players, maximum_players = payload[offset], payload[offset + 1]
        offset += 3
        texts = []
        for _ in range(3):
            size = payload[offset]
            offset += 1
            texts.append(payload[offset:offset + size].decode("ascii", "replace"))
            offset += size
    except (IndexError, struct.error):
        return None
    return {
        "version": version, "flags": flags, "sequence": sequence, "time": listed_time,
        "players": players, "maximum_players": maximum_players,
        "name": texts[0], "map": texts[1], "gametype": texts[2],
    }


def gather(broker: str, seconds: float, games: dict) -> None:
    """the listings one broker holds and hears within seconds, into games
    (by slot, the newest of each)"""
    host, port = broker.rsplit(":", 1)
    with socket.create_connection((host, int(port)), timeout=5) as connection:
        client = "hceu-list-" + os.urandom(4).hex()
        body = mqtt_string("MQTT") + bytes([4, 2]) + struct.pack(">H", 30) + mqtt_string(client)
        connection.sendall(bytes([0x10]) + mqtt_length(len(body)) + body)
        receive_packet(connection)
        body = struct.pack(">H", 1) + mqtt_string(SLOTS_TOPIC) + b"\x00"
        connection.sendall(bytes([0x82]) + mqtt_length(len(body)) + body)
        end = time.time() + seconds
        while time.time() < end:
            connection.settimeout(max(0.1, end - time.time()))
            try:
                header, data = receive_packet(connection)
            except socket.timeout:
                break
            if header >> 4 != 3:
                continue
            topic_size = struct.unpack(">H", data[:2])[0]
            topic = data[2:2 + topic_size].decode()
            payload = data[2 + topic_size:]
            if (header >> 1) & 3:
                payload = payload[2:]
            listing = parse_listing(payload)
            if not listing or listing["flags"] & FLAG_CLOSED:
                continue
            seen = games.get(topic)
            if not seen or listing["sequence"] >= seen["sequence"]:
                games[topic] = listing


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seconds", type=float, default=6, help="how long to listen to each broker")
    parser.add_argument("--brokers", type=Path, default=BROKERS_FILE, help="a brokers file")
    parser.add_argument("--all", action="store_true", help="also show listings older than 10 minutes")
    arguments = parser.parse_args()

    games = {}
    for broker in read_brokers(arguments.brokers):
        try:
            gather(broker, arguments.seconds, games)
        except (OSError, EOFError) as error:
            print(f"{broker}: {error}", file=sys.stderr)

    now = time.time()
    by_version = collections.defaultdict(list)
    stale = 0
    for listing in games.values():
        if arguments.all or abs(listing["time"] - now) < STALE_SECONDS:
            by_version[listing["version"]].append(listing)
        else:
            stale += 1
    for version in sorted(by_version):
        listings = by_version[version]
        players = sum(listing["players"] for listing in listings)
        print(f"version {version}: {len(listings)} games, {players} players")
        for listing in sorted(listings, key=lambda listing: -listing["players"]):
            notes = ""
            if not listing["flags"] & FLAG_OPEN:
                notes += " closed"
            if listing["flags"] & FLAG_IN_PROGRESS:
                notes += " in-progress"
            if listing["flags"] & FLAG_PASSWORD:
                notes += " password"
            count = f"{listing['players']}/{listing['maximum_players']}"
            print(f"  {count:>7} {listing['name'][:28]:28} {listing['map'][:20]:20} {listing['gametype'][:20]}{notes}")
    if stale:
        print(f"({stale} listings older than 10 minutes left out: --all shows them)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
