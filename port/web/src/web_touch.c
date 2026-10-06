/*
WEB_TOUCH.C

The page's touch controls (app/src/TouchControls.jsx, app/src/touch.js) as a
gamepad. The page writes what the player's fingers hold into a block of the
game's memory (struct web_touch_state); on the game's thread, before each
pump of the events (sdl_platform.c platform_pump_events), it goes into an
SDL virtual gamepad, which xinput_sdl.c takes up with the keyboard as port
0's (as it does the first real gamepad). The stick, the buttons and the
triggers are SDL's own numbers (SDL_GamepadAxis, SDL_GamepadButton), which
the page uses too, so there is no mapping here: the game sees an Xbox
controller with its default layout (A jumps, the right trigger fires).

The gamepad exists from the first touch on: a page with a mouse never has
one. The other way, the game tells the page whether a menu is up, for the
controls it shows (the menus' D-pad, A and B; else the game's).

A finger on the canvas itself is not here: SDL's finger events, which
sdl_platform.c takes as the menus' pointer and the aim.
*/

#include <SDL3/SDL.h>
#include <emscripten/emscripten.h>
#include <stdio.h>

enum
{
	TOUCH_MAGIC = 0x544F5543,
	TOUCH_VERSION = 1,
	/* the standard buttons: SDL_GAMEPAD_BUTTON_SOUTH to DPAD_RIGHT */
	BUTTON_COUNT = SDL_GAMEPAD_BUTTON_DPAD_RIGHT + 1,
};

struct web_touch_state
{
	unsigned int magic;
	unsigned int version;
	/* the page's: 1 from its first touch */
	unsigned int touched;
	/* the left stick, SDL's way: -32767 to 32767, y down */
	int stick_x, stick_y;
	/* the buttons held: 1 << SDL_GamepadButton */
	unsigned int buttons;
	/* the triggers held: bit 0 the left, bit 1 the right */
	unsigned int triggers;
	/* the game's: 1 while a menu is up */
	unsigned int menus;
};

static struct web_touch_state state = { TOUCH_MAGIC, TOUCH_VERSION };
static SDL_Joystick *gamepad;

/* the page's: where the state is */
EMSCRIPTEN_KEEPALIVE struct web_touch_state *web_touch_state(void)
{
	return &state;
}

/* (every standard button and axis, in SDL's order: the virtual gamepad's
button and axis numbers are then SDL_GamepadButton's and SDL_GamepadAxis's) */
static void attach(void)
{
	SDL_VirtualJoystickDesc desc;
	SDL_JoystickID id;

	SDL_INIT_INTERFACE(&desc);
	desc.type = SDL_JOYSTICK_TYPE_GAMEPAD;
	desc.naxes = SDL_GAMEPAD_AXIS_COUNT;
	desc.nbuttons = BUTTON_COUNT;
	desc.button_mask = (1u << BUTTON_COUNT) - 1;
	desc.axis_mask = (1u << SDL_GAMEPAD_AXIS_COUNT) - 1;
	desc.name = "Touch controls";
	id = SDL_AttachVirtualJoystick(&desc);
	gamepad = id ? SDL_OpenJoystick(id) : NULL;
	if (gamepad)
		printf("web: the touch controls are a gamepad\n");
	else
		printf("web: cannot attach the touch controls: %s\n", SDL_GetError());
}

void web_touch_pump(int menus)
{
	unsigned int buttons, triggers;
	int button;

	__atomic_store_n(&state.menus, menus ? 1u : 0u, __ATOMIC_RELEASE);
	if (!__atomic_load_n(&state.touched, __ATOMIC_ACQUIRE))
		return;
	if (!gamepad)
	{
		attach();
		if (!gamepad)
		{
			/* (not asked again) */
			__atomic_store_n(&state.touched, 0u, __ATOMIC_RELEASE);
			return;
		}
	}
	SDL_SetJoystickVirtualAxis(gamepad, SDL_GAMEPAD_AXIS_LEFTX, (Sint16)__atomic_load_n(&state.stick_x, __ATOMIC_ACQUIRE));
	SDL_SetJoystickVirtualAxis(gamepad, SDL_GAMEPAD_AXIS_LEFTY, (Sint16)__atomic_load_n(&state.stick_y, __ATOMIC_ACQUIRE));
	buttons = __atomic_load_n(&state.buttons, __ATOMIC_ACQUIRE);
	for (button = 0; button < BUTTON_COUNT; button++)
		SDL_SetJoystickVirtualButton(gamepad, button, (buttons >> button) & 1u);
	/* (a trigger's axis runs from the joystick's minimum, let go, to its
	maximum, pulled) */
	triggers = __atomic_load_n(&state.triggers, __ATOMIC_ACQUIRE);
	SDL_SetJoystickVirtualAxis(gamepad, SDL_GAMEPAD_AXIS_LEFT_TRIGGER,
		triggers & 1u ? SDL_JOYSTICK_AXIS_MAX : SDL_JOYSTICK_AXIS_MIN);
	SDL_SetJoystickVirtualAxis(gamepad, SDL_GAMEPAD_AXIS_RIGHT_TRIGGER,
		triggers & 2u ? SDL_JOYSTICK_AXIS_MAX : SDL_JOYSTICK_AXIS_MIN);
}
