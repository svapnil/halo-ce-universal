#!/bin/sh
# Hosts a native game for the browser build's tests (README.md here): a
# desktop build's release from GitHub, headless in Docker, hosting a
# scripted game; with a relay on the same Docker network, which reaches the
# host there. Prints the host's invite.
#
#   port/web/relay/test/native_host.sh [release tag, or a release's zip] [map]
#   port/web/relay/test/native_host.sh stop
#
# The release's HALO_PORT_NETWORK_VERSION must be the browser build's
# (port/linux/include/halo_port_limits.h): pick the tag whose commit has it.
# Upstream keeps its last five releases only: keep the zip of the one that
# matches (halo-linux-release.zip), and give its path once the tag is gone.
set -e
cd "$(dirname "$0")"
root=$(cd ../../../.. && pwd)
work=${HALO_TEST_DIR:-${TMPDIR:-/tmp}/halo-native-host}

if [ "$1" = stop ]; then
	docker rm -f halo-native-host halo-relay >/dev/null 2>&1 || true
	docker network rm halonet >/dev/null 2>&1 || true
	exit 0
fi
tag=${1:-build-154}
map=${2:-bloodgulch}

mkdir -p "$work/release" "$work/saves"
if [ -f "$tag" ]; then
	zip=$(cd "$(dirname "$tag")" && pwd)/$(basename "$tag")
	tag=$(basename "$tag" .zip)
	mkdir -p "$work/release/$tag"
	(cd "$work/release/$tag" && unzip -o -q "$zip")
elif [ ! -f "$work/release/$tag/halo" ]; then
	mkdir -p "$work/release/$tag"
	gh release download "$tag" -R cybersecurity/halo-ce-universal -p halo-linux-release.zip -D "$work/release/$tag" --clobber
	(cd "$work/release/$tag" && unzip -o -q halo-linux-release.zip)
fi
docker build --platform linux/amd64 -q -t halo-native-host -f native-host.Dockerfile . >/dev/null
docker build -q -t halo-web-relay --target relay ../.. >/dev/null
docker network create halonet >/dev/null 2>&1 || true
docker rm -f halo-native-host halo-relay >/dev/null 2>&1 || true

# (Docker Desktop's file sharing drops the executable bit: run a copy, with
# the release's brokers.txt beside it, where the game reads its brokers)
docker run -d --name halo-native-host --network halonet --platform linux/amd64 \
	-v "$work/release/$tag":/halo:ro -v "$root/assets":/data:ro -v "$work/saves":/saves -w /data \
	-e XDG_DATA_HOME=/saves -e SDL_VIDEO_DRIVER=offscreen -e SDL_AUDIO_DRIVER=dummy \
	-e HALO_NULL_RENDERER=1 -e HALO_HIDDEN_WINDOW=1 \
	-e HALO_NETWORK_TEST="host:$map" -e HALO_NETWORK_TEST_START=20 \
	-e HALO_TEST_INPUT=bot:1 -e HALO_NETWORK_TEST_SHOOT=5 -e HALO_NETWORK_TEST_KILL=20 \
	halo-native-host sh -c 'cp /halo/halo /tmp/halo && chmod +x /tmp/halo && { cp /halo/brokers.txt /tmp/ 2>/dev/null || true; } && exec /tmp/halo' >/dev/null
docker run -d --name halo-relay --network halonet -p 8790:8790 -e RELAY_INSECURE=1 -e RELAY_REPORT=1 \
	halo-web-relay >/dev/null

printf 'waiting for the host'
until docker logs halo-native-host 2>&1 | grep -q 'halo://join/'; do
	printf .
	sleep 2
done
echo
docker logs halo-native-host 2>&1 | grep -o 'halo://join/[0-9a-f]*' | tail -1
