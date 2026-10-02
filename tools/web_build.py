"""Ninja rules for the browser build (``ninja web``).

It compiles the same units as the native Linux build (tools/linux_build.py)
with Emscripten for WebAssembly, adds ``port/web/src``, and links
``build/web/halo.html`` with ``halo.js`` and ``halo.wasm``. WebAssembly
(wasm32) has 32-bit pointers, as the game's data needs. See
port/web/README.md for the design; tools/web_serve.py serves the build.
"""

from pathlib import Path
from typing import Any, Dict, List

from .linux_build import (
    GAME_FLAGS, KCP_DIR, LINUX_ABI_FLAGS, MBEDTLS_DIR, MINIUPNPC_DEFINES, MINIUPNPC_DIR, OPTIMISATION,
    PLATFORM_FLAGS, PORT_CONFIG, PORT_DIR, POSIX_FLAGS, TOML_DIR, XDK_INCLUDE, _load_port_config,
    game_defines_and_includes, game_sources, miniupnpc_sources, musl_math_cflags, musl_math_sources,
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
    "source/cache/cache_files_windows.c": ["CreateThread=halo_web_create_thread_void"],
    "source/rasterizer/xbox/rasterizer_xbox_text.c": [
        "rasterizer_set_texture_bitmap_data=halo_web_rasterizer_set_texture_bitmap_data"],
    "source/rasterizer/xbox/rasterizer_xbox_motion_sensor.c": [
        "rasterizer_set_texture_bitmap_data=halo_web_rasterizer_set_texture_bitmap_data"],
    "source/rasterizer/xbox/rasterizer_xbox_plasma_energy.c": [
        "rasterizer_set_texture=halo_web_rasterizer_set_texture"],
}

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
    f"--shell-file={WEB_DIR / 'shell.html'}",
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
    output = build_dir / "halo.html"
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
        f"-I{KCP_DIR}",
        "-Isource -Isource/cseries",
        sdk_flags,
    ])
    posix_abi = [flag for flag in POSIX_FLAGS if flag not in NOT_WEB_FLAGS] + ["-pthread", "--use-port=sdl3"]
    posix_cflags = " ".join(posix_abi + [f"-I{platform_dir}"])
    mbedtls_include = f"-I{MBEDTLS_DIR / 'include'}"
    for source in sorted(platform_dir.glob("*.c")):
        if source.name == "posix_update.c":
            add_object(source, f"{posix_cflags} {mbedtls_include}")
        elif source.name == "posix_upnp.c":
            add_object(source, f"{posix_cflags} -I{MINIUPNPC_DIR / 'include'} -DMINIUPNP_STATICLIB")
        elif source.name.startswith("posix_"):
            add_object(source, posix_cflags)
        elif source.name == "updater.c":
            add_object(source, f"{platform_cflags} {updater_defines(release)}")
        elif source.name in GLES_RENDERER_UNITS:
            add_object(source, f"{platform_cflags} -DHALO_ANDROID=1")
        else:
            add_object(source, platform_cflags)
    for source in embedded_assets:
        add_object(source, platform_cflags)
    for source in sorted((WEB_DIR / "src").glob("*.c")):
        add_object(source, platform_cflags)
    for source in sorted((MBEDTLS_DIR / "library").glob("*.c")):
        add_object(source, " ".join(posix_abi + [mbedtls_include, f"-I{MBEDTLS_DIR / 'library'}",
                                                 "-fno-builtin-wcslen", "-w"]))
    for source in miniupnpc_sources():
        add_object(source, " ".join(posix_abi + [*MINIUPNPC_DEFINES, f"-I{MINIUPNPC_DIR / 'include'}",
                                                 f"-I{MINIUPNPC_DIR / 'src'}", "-fno-builtin-wcslen", "-w"]))
    add_object(TOML_DIR / "tomlc17.c", " ".join([abi, "-std=gnu11", "-w"]))
    add_object(KCP_DIR / "ikcp.c", " ".join([abi, "-std=gnu11", "-w"]))
    for source in musl_math_sources():
        add_object(source, musl_math_cflags(abi))

    ldflags = WEB_LINK_FLAGS + ([] if release else ["-sASSERTIONS=1"])
    n.build(
        outputs=output,
        rule="web_link",
        inputs=objects,
        implicit=[WEB_DIR / "shell.html"],
        implicit_outputs=[build_dir / "halo.js", build_dir / "halo.wasm"],
        variables={"ldflags": " ".join(ldflags)},
    )
    n.build(outputs="web", rule="phony", inputs=output)
    n.newline()

