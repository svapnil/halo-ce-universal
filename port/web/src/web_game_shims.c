/*
WEB_GAME_SHIMS.C

Calls in the game source whose types do not match the function they reach.
x86 and AArch64 ignore the difference; WebAssembly checks the type of every
call against the function's and traps where they differ. The game source
stays as it is (it matches the MSVC build byte for byte): tools/web_build.py
renames the calls in the units that make them (WEB_GAME_RENAMES) to these
functions, which make them with the right types.
*/

#include "platform.h"

/* cache_files_windows.c starts its thread with a void (void) procedure cast
to a thread routine */
static DWORD WINAPI call_void_procedure(LPVOID procedure)
{
	((void (*)(void))procedure)();
	return 0;
}

HANDLE WINAPI halo_web_create_thread_void(LPSECURITY_ATTRIBUTES attributes, DWORD stack_size,
	LPTHREAD_START_ROUTINE start, LPVOID parameter, DWORD flags, LPDWORD thread_id)
{
	(void)parameter;
	return CreateThread(attributes, stack_size, call_void_procedure, (LPVOID)start, flags, thread_id);
}

/* rasterizer_xbox_text.c and rasterizer_xbox_motion_sensor.c declare
rasterizer_set_texture_bitmap_data as returning nothing, and
rasterizer_xbox_plasma_energy.c rasterizer_set_texture; both return a value
(rasterizer_xbox.c) */
struct bitmap_data;
union point2d;
unsigned char rasterizer_set_texture_bitmap_data(short stage, struct bitmap_data const *bitmap);
union point2d *rasterizer_set_texture(short stage, short bitmap_type, short bitmap_index,
	long bitmap_definition_index, short bitmap_sequence_index);

void halo_web_rasterizer_set_texture_bitmap_data(short stage, struct bitmap_data const *bitmap)
{
	rasterizer_set_texture_bitmap_data(stage, bitmap);
}

void halo_web_rasterizer_set_texture(short stage, short bitmap_type, short bitmap_index,
	long bitmap_definition_index, short bitmap_sequence_index)
{
	rasterizer_set_texture(stage, bitmap_type, bitmap_index, bitmap_definition_index, bitmap_sequence_index);
}
