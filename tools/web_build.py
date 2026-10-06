"""Ninja rules for the browser build (``ninja web``).

It compiles the same units as the native Linux build (tools/linux_build.py)
with Emscripten for WebAssembly, adds ``port/web/src``, and links
``build/web/halo.js`` and ``halo.wasm``. WebAssembly
(wasm32) has 32-bit pointers, as the game's data needs. See
port/web/README.md for the design; the worker in port/web/worker serves the
build (port/web/wrangler.toml).
"""

from pathlib import Path
from typing import Any, Dict, List

from .linux_build import (
    EXPAT_DIR, EXPAT_SOURCES, GAME_FLAGS, KCP_DIR, LINUX_ABI_FLAGS, MBEDTLS_DIR, MONOCYPHER_DIR, OPTIMISATION,
    PLATFORM_FLAGS, PORT_CONFIG, PORT_DIR, POSIX_FLAGS, TOML_DIR, XDK_INCLUDE, _load_port_config,
    game_defines_and_includes, game_sources, musl_math_cflags, musl_math_sources,
    updater_defines, xdk_headers,
)
from .ninja_syntax import Writer

WEB_DIR = Path("port/web")

# The Linux ABI flags that do not apply to WebAssembly: its target, and the
# x86 layout and calling convention options (wasm32 already aligns doubles
# and 64-bit integers to 8 bytes, as MSVC does). -g: the browser build keeps
# function names only (the link's -g2), not DWARF.
NOT_WEB_FLAGS = {"--target=i686-linux-gnu", "-m32", "-malign-double", "-freg-struct-return", "-fno-pic", "-g"}

WEB_ABI_FLAGS = [flag for flag in LINUX_ABI_FLAGS if flag not in NOT_WEB_FLAGS] + ["-pthread", "--use-port=sdl3"]

# The renderer's OpenGL ES path, written for the Android port, is the one
# WebGL 2 can run (HALO_ANDROID in these units; port/web/src/web_gl.c stands
# in for the Android host's helpers).
GLES_RENDERER_UNITS = {
    "d3d8_gl.c", "d3d8_resources.c", "gl_functions.c", "nv2a_psh.c", "nv2a_vsh.c", "xbox_textures.c",
}

# Calls whose types do not match the function they reach: WebAssembly traps
# on them, x86 does not. The game source stays as it is; these units call
# port/web/src/web_game_shims.c instead.
WEB_GAME_RENAMES: Dict[str, List[str]] = {
    "source/shell/shell_xbox.c": ["main=halo_main"],
    # (the browser's online games run once a frame with the network tests:
    # port/web/src/web_lobby.c)
    "source/main/main.c": ["network_test_update=web_frame_update", "exit=web_exit"],
    "source/cache/cache_files_windows.c": ["CreateThread=halo_web_create_thread_void"],
    "source/rasterizer/xbox/rasterizer_xbox_text.c": [
        "rasterizer_set_texture_bitmap_data=halo_web_rasterizer_set_texture_bitmap_data"],
    "source/rasterizer/xbox/rasterizer_xbox_motion_sensor.c": [
        "rasterizer_set_texture_bitmap_data=halo_web_rasterizer_set_texture_bitmap_data"],
    "source/rasterizer/xbox/rasterizer_xbox_plasma_energy.c": [
        "rasterizer_set_texture=halo_web_rasterizer_set_texture"],
    "source/objects/object_types.c": [
        "game_engine_vehicle_placement_begin=halo_web_game_engine_vehicle_placement_begin"],
    "source/networking/network_game_manager.c": ["player_delete=halo_web_player_delete"],
}

# Network play (port/web/NETWORK.md, "The game's side"). The game and
# xnet.c stay as they are; under them, the browser build has its own:
#  - sockets: web_net.c's posix_socket_* (in this page's memory). posix_net.c
#    keeps its other functions, with these renamed out of the way;
#  - internet play: web_p2p.c's p2p.h (browsers, through the SFU), or the
#    desktop's own (native games, through the relay), as the page chooses
#    (below). miniupnpc, which only UPnP uses, is left out.
WEB_NET_FUNCTIONS = [
    "posix_socket_last_error", "posix_socket", "posix_socket_close", "posix_socket_bind", "posix_socket_connect",
    "posix_socket_listen", "posix_socket_accept", "posix_socket_send", "posix_socket_sendto", "posix_socket_recv",
    "posix_socket_recvfrom", "posix_socket_shutdown", "posix_socket_set_nonblocking", "posix_socket_bytes_available",
    "posix_socket_set_nodelay", "posix_socket_setsockopt", "posix_socket_getsockopt", "posix_socket_getsockname",
    "posix_socket_getpeername", "posix_socket_select", "posix_local_ipv4_address",
    # (a name's address comes from the relay: web_net.c)
    "posix_resolve_ipv4",
]
# Native games (NETWORK.md, "Native games"): the desktop's internet play
# runs here too, its sockets to the internet through the relay (web_net.c).
# Both it and web_p2p.c implement p2p.h, so each is compiled with p2p.h's
# functions renamed (p2p_native_*, p2p_web_*), and web_p2p_select.c gives
# p2p.h to the game, from the one the page chose. UPnP is left out: behind
# the relay there is no router to ask (web_net.c has its stubs).
P2P_FUNCTIONS = [
    "p2p_initialize", "p2p_hand_off_invite", "p2p_join_invite", "p2p_identifier", "p2p_peer_address",
    "p2p_outgoing", "p2p_incoming", "p2p_broadcast_targets", "p2p_send_datagram", "p2p_broadcast_datagram",
    "p2p_socket_port", "p2p_port_taken", "p2p_socket_closed", "p2p_take_clipboard_text",
    "p2p_set_game_player_counts", "p2p_discord_sanitize", "p2p_discord_identity", "p2p_hardware_id",
    "p2p_hardware_id_sanitize", "p2p_peer_endpoint_address",
    # (the PC menus' internet games, and their server browser: p2p_lobby.c)
    "p2p_set_hosting_allowed", "p2p_invite_link", "p2p_set_hosting_public", "p2p_set_game_listing",
    "p2p_lobby_browse", "p2p_lobby_refresh", "p2p_lobby_games", "p2p_lobby_mark_failed",
]
# the platform layer's functions the browser build has its own of, renamed
# out of the way in their units: the clipboard, which the page's main thread
# has (port/web/src/web_clipboard.c)
WEB_PLATFORM_RENAMES: Dict[str, List[str]] = {
    "sdl_platform.c": ["platform_clipboard_get=platform_sdl_clipboard_get",
                       "platform_clipboard_set=platform_sdl_clipboard_set",
                       "exit=web_exit"],
    # the game's exits (its Quit: xbox_xapi.c's XLaunchNewImage; the SDL quit
    # event) go through port/web/src/web_crash.c's, which tells the page first
    "xbox_xapi.c": ["exit=web_exit"],
    "updater.c": ["exit=web_exit"],
}
NATIVE_INTERNET_PLAY_UNITS = {"p2p.c", "p2p_signal.c", "p2p_crypto.c", "p2p_discord.c", "p2p_lobby.c"}
DESKTOP_INTERNET_PLAY_UNITS = {"posix_upnp.c"}
# the browser's units with the host ABI, as posix_*.c (they implement posix.h),
# and those with the game's (they call it, as port/linux/game's do)
WEB_POSIX_UNITS = {"web_net.c", "web_crash.c"}
WEB_GAME_UNITS = {"web_lobby.c"}

# The page, its threads and its memory:
#  - the game runs on a worker (PROXY_TO_PTHREAD) and draws on the canvas
#    from there (OFFSCREENCANVAS_SUPPORT), so that it can block as it does on
#    the desktop;
#  - each frame it suspends until the browser's next one (JSPI;
#    sdl_platform.c platform_video_swap);
#  - its files are WasmFS, whose fetch backend reads the maps from the
#    server (port/web/src/web_main.c);
#  - its memory grows past the Xbox window at 0x80000000 (xbox_memory.c).
WEB_LINK_FLAGS = [
    "-pthread", "--use-port=sdl3", OPTIMISATION, "-g2",
    "-sENVIRONMENT=web,worker",
    "-sPROXY_TO_PTHREAD=1", "-sOFFSCREENCANVAS_SUPPORT=1", "-sPTHREAD_POOL_SIZE=16",
    "-sUSE_WEBGL2=1", "-sMIN_WEBGL_VERSION=2", "-sMAX_WEBGL_VERSION=2",
    "-sJSPI=1",
    "-sWASMFS=1",
    "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=256MB", "-sMAXIMUM_MEMORY=4GB", "-sSTACK_SIZE=4MB",
    # the page's network bridge reads web_p2p.c's rings (app/src/net_bridge.js)
    "-sEXPORTED_RUNTIME_METHODS=HEAPU8",
]


def web_configure_inputs() -> List[Path]:
    return [Path("tools/web_build.py")]


def generate_web_build(n: Writer, sln: Any) -> None:
    if not PORT_CONFIG.is_file():
        return
    config = _load_port_config()
    emcc = getattr(sln, "emcc", None) or "emcc"
    linux_dir: Path = sln.build_dir / "linux"
    build_dir: Path = sln.build_dir / "web"
    obj_dir = build_dir / "obj"
    # the page is port/web/app (Vite and React), which loads halo.js
    output = build_dir / "halo.js"
    release = getattr(sln, "port_release", False)

    # the generated headers and assets of the Linux build, which are the same
    # for every target (tools/linux_build.py emits their rules)
    prefix_header = PORT_DIR / "include" / "halo_linux_prefix.h"
    semantics_header = linux_dir / "halo_msvc_semantics.h"
    platform_semantics_header = linux_dir / "platform_msvc_semantics.h"
    embedded_assets = [linux_dir / "generated" / "hud_hires_assets.c"]
    fixups_header = WEB_DIR / "include" / "halo_web_fixups.h"

    n.comment("Browser build (ninja web): Emscripten, WebAssembly")
    n.variable("emcc", emcc)
    n.rule(
        name="web_cc",
        command="$emcc -MMD -MF $out.d $cflags -c $in -o $out",
        description="WEB CC $out",
        depfile="$out.d",
        deps="gcc",
    )
    n.rule(
        name="web_link",
        command="$emcc $ldflags -o $out @$out.rsp",
        description="WEB LINK $out",
        rspfile="$out.rsp",
        rspfile_content="$in_newline",
    )

    abi = " ".join(WEB_ABI_FLAGS + (["-DHALO_RELEASE"] if release else []))
    port_include = PORT_DIR / "include"
    sdk_flags = f"-idirafter {XDK_INCLUDE}"
    objects: List[Path] = []

    def add_object(source: Path, cflags: str) -> None:
        obj = obj_dir / source.with_suffix(".o")
        objects.append(obj)
        n.build(
            outputs=obj,
            rule="web_cc",
            inputs=source,
            implicit=[*xdk_headers(), prefix_header, semantics_header, platform_semantics_header, fixups_header],
            variables={"cflags": cflags},
        )

    def renames(source: Path) -> str:
        return " ".join(f"-D{rename}" for rename in WEB_GAME_RENAMES.get(source.as_posix(), []))

    game_cflags = " ".join([
        abi,
        " ".join(GAME_FLAGS),
        f"-include {prefix_header}",
        f"-include {semantics_header}",
        f"-include {fixups_header}",
        f"-I{port_include}",
        game_defines_and_includes(config),
        # the headers of the port's own game units (port/linux/game), for
        # the game sources that call them (as tools/linux_build.py)
        f"-iquote {Path(config['game_sources'])}",
        sdk_flags,
    ])
    for source in game_sources(config):
        add_object(source, f"{game_cflags} {renames(source)}")
    for source in sorted(Path(config["game_sources"]).glob("*.c")):
        add_object(source, game_cflags)

    platform_dir = Path(config["platform_sources"])
    platform_cflags = " ".join([
        abi,
        " ".join(PLATFORM_FLAGS),
        "-Wno-unused-but-set-variable",
        f"-include {prefix_header}",
        f"-include {platform_semantics_header}",
        f"-I{platform_dir}",
        f"-I{port_include}",
        f"-I{TOML_DIR}",
        f"-I{EXPAT_DIR}",
        f"-I{KCP_DIR}",
        f"-I{MONOCYPHER_DIR}",
        "-Isource -Isource/cseries",
        sdk_flags,
    ])
    posix_abi = [flag for flag in POSIX_FLAGS if flag not in NOT_WEB_FLAGS] + ["-pthread", "--use-port=sdl3"]
    posix_cflags = " ".join(posix_abi + [f"-I{platform_dir}"])
    mbedtls_include = f"-I{MBEDTLS_DIR / 'include'}"
    native_sockets = " ".join(f"-D{name}=posix_native_{name[len('posix_'):]}" for name in WEB_NET_FUNCTIONS)

    def p2p_renames(prefix: str) -> str:
        return " ".join(f"-D{name}={prefix}_{name[len('p2p_'):]}" for name in P2P_FUNCTIONS)

    for source in sorted(platform_dir.glob("*.c")):
        if source.name in DESKTOP_INTERNET_PLAY_UNITS:
            continue
        if source.name in NATIVE_INTERNET_PLAY_UNITS:
            add_object(source, f"{platform_cflags} {p2p_renames('p2p_native')}")
            continue
        if source.name == "posix_update.c":
            add_object(source, f"{posix_cflags} {mbedtls_include}")
        elif source.name == "posix_net.c":
            add_object(source, f"{posix_cflags} {native_sockets}")
        elif source.name.startswith("posix_"):
            add_object(source, posix_cflags)
        elif source.name == "updater.c":
            add_object(source, f"{platform_cflags} {updater_defines(release)}")
        elif source.name in GLES_RENDERER_UNITS:
            add_object(source, f"{platform_cflags} -DHALO_ANDROID=1")
        else:
            platform_renames = " ".join(f"-D{rename}" for rename in WEB_PLATFORM_RENAMES.get(source.name, []))
            add_object(source, f"{platform_cflags} {platform_renames}")
    for source in embedded_assets:
        add_object(source, platform_cflags)
    for source in sorted((WEB_DIR / "src").glob("*.c")):
        if source.name in WEB_POSIX_UNITS:
            add_object(source, posix_cflags)
        elif source.name in WEB_GAME_UNITS:
            add_object(source, game_cflags)
        elif source.name == "web_p2p.c":
            add_object(source, f"{platform_cflags} {p2p_renames('p2p_web')}")
        else:
            add_object(source, platform_cflags)
    add_object(KCP_DIR / "ikcp.c", " ".join([abi, "-std=gnu11", "-w"]))
    # the PC menus' XML parser (menu_files.c), and the signatures of the
    # server browser's listings (p2p_crypto.c), as the Linux build has them
    for name in EXPAT_SOURCES:
        add_object(EXPAT_DIR / name, " ".join([abi, "-std=gnu11", f"-I{EXPAT_DIR}", "-w"]))
    for name in ("monocypher.c", "monocypher-ed25519.c"):
        add_object(MONOCYPHER_DIR / name, " ".join([abi, "-std=gnu11", "-w"]))
    for source in sorted((MBEDTLS_DIR / "library").glob("*.c")):
        add_object(source, " ".join(posix_abi + [mbedtls_include, f"-I{MBEDTLS_DIR / 'library'}",
                                                 "-fno-builtin-wcslen", "-w"]))
    add_object(TOML_DIR / "tomlc17.c", " ".join([abi, "-std=gnu11", "-w"]))
    for source in musl_math_sources():
        add_object(source, musl_math_cflags(abi))

    # (the threads' part of crash reports: port/web/src/web_pre.js)
    pre_js = WEB_DIR / "src" / "web_pre.js"
    # internet play's MQTT brokers (network.brokers_file), a file beside
    # config.toml as on the desktop: here in the game's own files, at /. The
    # relay reaches only the brokers it knows: RELAY_BROKERS
    # (port/web/relay/main.go) names these too.
    brokers = Path("port/assets/network/brokers.txt")
    ldflags = (WEB_LINK_FLAGS + [f"--pre-js {pre_js}", f"--embed-file {brokers}@/brokers.txt"] +
               ([] if release else ["-sASSERTIONS=1"]))
    n.build(
        outputs=output,
        rule="web_link",
        inputs=objects,
        implicit=[pre_js, brokers],
        implicit_outputs=[build_dir / "halo.wasm"],
        variables={"ldflags": " ".join(ldflags)},
    )
    # the worker serves build/web as its static assets (port/web/wrangler.toml), which
    # must not include the object files
    assets_ignore = build_dir / ".assetsignore"
    n.rule(
        name="web_assetsignore",
        command="$python -c \"open(r'$out', 'w').write('obj' + chr(10))\"",
        description="WEB $out",
    )
    n.build(outputs=assets_ignore, rule="web_assetsignore", implicit=[Path("tools/web_build.py")])
    n.build(outputs="web", rule="phony", inputs=[output, assets_ignore])
    n.newline()

