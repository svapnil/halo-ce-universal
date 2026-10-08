/*
WEB_GAMEPAD.C

When a gamepad is connected, SDL asks its vendor, its product and whether it
is an XInput one (SDL_sysjoystick.c's Emscripten_JoyStickConnected, with
EM_JS of these names). It asks from the game's thread, a worker, which has
no Gamepad API: navigator.getGamepads there is web_pre.js's, with no
gamepads, so SDL's EM_JS read the id of no gamepad, and the game ended.

These, defined here, take the place of SDL's: the same reading of the
gamepad's id, done on the page's thread, where the gamepads are. A gamepad
that is gone by then is of no vendor or product, as SDL has it for an id it
does not understand.
*/

#include <emscripten/em_asm.h>

int SDL_GetEmscriptenJoystickVendor(int device_index)
{
	return MAIN_THREAD_EM_ASM_INT({
		let gamepad = navigator.getGamepads()[$0];
		if (!gamepad) {
			return 0;
		}
		/* Chrome, Edge: "Xbox 360 Controller (XInput STANDARD GAMEPAD Vendor: 045e Product: 028e)" */
		let at = gamepad.id.indexOf("Vendor: ");
		if (at > 0) {
			return parseInt(gamepad.id.substr(at + 8, 4), 16) || 0;
		}
		/* Firefox, Safari: "45e-28e-Xbox 360 Wired Controller" */
		let parts = gamepad.id.split("-");
		if (parts.length > 1 && !isNaN(parseInt(parts[0], 16))) {
			return parseInt(parts[0], 16);
		}
		return 0;
	}, device_index);
}

int SDL_GetEmscriptenJoystickProduct(int device_index)
{
	return MAIN_THREAD_EM_ASM_INT({
		let gamepad = navigator.getGamepads()[$0];
		if (!gamepad) {
			return 0;
		}
		let at = gamepad.id.indexOf("Product: ");
		if (at > 0) {
			return parseInt(gamepad.id.substr(at + 9, 4), 16) || 0;
		}
		let parts = gamepad.id.split("-");
		if (parts.length > 1 && !isNaN(parseInt(parts[1], 16))) {
			return parseInt(parts[1], 16);
		}
		return 0;
	}, device_index);
}

int SDL_IsEmscriptenJoystickXInput(int device_index)
{
	return MAIN_THREAD_EM_ASM_INT({
		let gamepad = navigator.getGamepads()[$0];
		return gamepad && gamepad.id.toLowerCase().indexOf("xinput") >= 0 ? 1 : 0;
	}, device_index);
}
