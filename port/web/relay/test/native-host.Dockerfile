# A desktop (Linux) build's runtime, to host native games for the browser
# build's tests (port/web/relay/test/README.md). The Linux build is 32-bit
# x86 and needs a recent glibc: Arch's multilib, as the CI's (.github).
# On an arm64 Mac, Docker runs it under emulation.
FROM --platform=linux/amd64 archlinux:latest
# (pacman's sandbox does not work under emulation)
RUN sed -i 's/^\[options\]/[options]\nDisableSandbox/' /etc/pacman.conf && \
    printf '\n[multilib]\nInclude = /etc/pacman.d/mirrorlist\n' >> /etc/pacman.conf && \
    pacman -Syu --noconfirm --needed lib32-glibc lib32-gcc-libs lib32-sdl3 lib32-libglvnd lib32-mesa nodejs && \
    pacman -Scc --noconfirm
