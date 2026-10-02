/*
HALO_WEB_FIXUPS.H

Force-included ahead of the game's units in the browser build
(tools/web_build.py), after halo_linux_prefix.h.

MSVC's va_list is a char *, and the game declares some argument lists as
one (terminal.c). WebAssembly's va_list is a different pointer type, which
va_start and va_end will not accept; both are a single pointer, so these
take either.
*/

#ifndef __HALO_WEB_FIXUPS_H
#define __HALO_WEB_FIXUPS_H

#include <stdarg.h>

#undef va_start
#undef va_end
#undef va_arg
#undef va_copy
#define va_start(list, last) __builtin_va_start(*(__builtin_va_list *)&(list), last)
#define va_end(list) __builtin_va_end(*(__builtin_va_list *)&(list))
#define va_arg(list, type) __builtin_va_arg(*(__builtin_va_list *)&(list), type)
#define va_copy(destination, source) \
	__builtin_va_copy(*(__builtin_va_list *)&(destination), *(__builtin_va_list *)&(source))

#endif
