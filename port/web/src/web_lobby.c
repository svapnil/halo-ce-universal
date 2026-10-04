/*
WEB_LOBBY.C

The browser build's side of joining a game from an invite link
(app/src/lobby.js, game.js; NETWORK.md, "The lobby"). The game's own menus
(the PC version's) host and join games, as on the desktop; but a page
opened with an invite (a browser's room, #join=, or a desktop build's game,
#native=) links to its host, and the page then asks the game, from the main
menu, to join the game the host's link brings: the first game the search
finds, then its lobby (the menus', as their own join opens it).

It runs on the game's thread, once a frame: tools/web_build.py renames
main.c's call of port/linux/game/network_test.c's network_test_update to
web_frame_update, which calls it and then this. Joining takes
network_test.c's own steps (the first game the search finds), so that it
takes the paths the netcode's tests take.

The page and the game share a mailbox (struct web_lobby_mailbox): the page
writes a request and raises request_sequence; the game writes its phase
and raises and notifies event_sequence (Atomics.waitAsync on the page).
*/

#include "cseries.h"
#include "main/main.h"
#include "interface/player_ui.h"
#include "interface/ui_widget.h"
#include "saved games/player_profile.h"
#include "networking/network_game_globals.h"
#include "networking/network_client_manager.h"
#include "networking/network_server_manager.h"
#include "game/game.h"

#include <emscripten/emscripten.h>
#include <stdio.h>
#include <string.h>

void network_test_update(boolean main_menu_loaded, real seconds);
/* (port/linux/src/platform.h's and port_config.h's, which the game's units
do not include) */
void platform_log(char const *format, ...);
const char *config_string(const char *name);

enum
{
	MAILBOX_MAGIC = 0x4C4F4259,
	MAILBOX_VERSION = 3,
	MESSAGE_SIZE = 128,
};

/* the page's requests */
enum
{
	_request_none = 0,
	_request_join,
};

/* the game's phases, as the page reads them */
enum
{
	_phase_other = 0,
	_phase_main_menu,
	_phase_joining,
	_phase_joined,
	_phase_failed,
};

struct web_lobby_mailbox
{
	unsigned int magic;
	unsigned int version;
	/* the page's */
	unsigned int request_sequence;
	unsigned int request;
	/* the game's */
	unsigned int event_sequence;
	unsigned int phase;
	char message[MESSAGE_SIZE];
};

static struct web_lobby_mailbox mailbox = { MAILBOX_MAGIC, MAILBOX_VERSION };

/* what the lobby is doing */
enum
{
	_lobby_idle = 0,
	/* a join that waits for the main menu */
	_lobby_waiting,
	_lobby_join_searching,
	_lobby_joined,
};

/* (seconds) */
#define JOIN_SEARCH_TIME 30.0f
#define JOIN_TEAM_TIME 5.0f

/* the lobby screen a join opens: the PC menus' (port/linux/game/
menu_functions.c's LOBBY_NAME), or the Xbox's */
#define PC_LOBBY_SCREEN "pc\\main_menu\\multiplayer_type_select\\lobby\\lobby_screen"
#define XBOX_LOBBY_SCREEN "ui\\shell\\main_menu\\multiplayer_type_select\\connected\\pregame\\connected_pregame_screen"

static struct
{
	int state;
	unsigned int seen_request;
	real seconds;
	boolean team_set;
	/* the main menu was up last frame; the profile active then */
	boolean at_main_menu;
	long active_profile;
} lobby = { .active_profile = NONE };

static void lobby_phase(unsigned int phase, char const *message)
{
	snprintf(mailbox.message, sizeof(mailbox.message), "%s", message ? message : "");
	__atomic_store_n(&mailbox.phase, phase, __ATOMIC_RELEASE);
	__atomic_add_fetch(&mailbox.event_sequence, 1, __ATOMIC_SEQ_CST);
	__builtin_wasm_memory_atomic_notify((int *)&mailbox.event_sequence, ~0u);
}

/* the page's: where the mailbox is */
EMSCRIPTEN_KEEPALIVE struct web_lobby_mailbox *web_lobby_mailbox(void)
{
	return &mailbox;
}

/* Player 1's profile, whose name the game's player takes online
(network_game_client_add_player). The game's own menus have the player pick
it, and remember it in z:\lastprof.txt (saved_game_files.c), but a join
from an invite goes around them: so it takes the profile the player last
used, from that file, when none is active (as after a reload: the saves
persist, web_main.c). */
static void lobby_use_player1_profile(void)
{
	if (player_ui_get_active_player_profile_index(0) == NONE)
	{
		long profile_index = player_ui_get_player1_last_used_profile_index();
		struct player_profile profile;

		if (profile_index == NONE || !player_profile_get(profile_index, &profile))
			return;
		player_ui_set_active_player_profile(0, profile_index, &profile);
		platform_log("lobby: player 1's profile is the last one used");
	}
	player_ui_remember_player1_profile(TRUE);
}

/* the main menu comes and goes; a profile picked or made in the menus is
remembered as soon as it is, not only when a campaign starts */
static void lobby_watch_main_menu(boolean main_menu_loaded)
{
	long active = player_ui_get_active_player_profile_index(0);

	if (main_menu_loaded && active != NONE && active != lobby.active_profile)
		player_ui_remember_player1_profile(TRUE);
	lobby.active_profile = active;
	if (main_menu_loaded == lobby.at_main_menu)
		return;
	lobby.at_main_menu = main_menu_loaded;
	if (main_menu_loaded)
	{
		/* (back at the main menu: a game joined is over) */
		if (lobby.state == _lobby_joined)
			lobby.state = _lobby_idle;
		lobby_phase(_phase_main_menu, NULL);
	}
	else if (lobby.state == _lobby_idle)
		lobby_phase(_phase_other, NULL);
}

static void lobby_take_request(void)
{
	unsigned int sequence = __atomic_load_n(&mailbox.request_sequence, __ATOMIC_ACQUIRE);

	if (sequence == lobby.seen_request)
		return;
	lobby.seen_request = sequence;
	/* (one at a time) */
	if (mailbox.request == _request_join && (lobby.state == _lobby_idle || lobby.state == _lobby_joined))
		lobby.state = _lobby_waiting;
}

static void lobby_start_joining(void)
{
	lobby_use_player1_profile();
	dispose_global_network_game_client();
	dispose_global_network_game_server();
	if (!create_global_network_game_client())
	{
		lobby.state = _lobby_idle;
		lobby_phase(_phase_failed, "The game could not search for the host's game");
		return;
	}
	game_connection_set(_game_connection_network_client);
	/* (as a player picking their profile) */
	player_ui_local_player_joined_multiplayer_game(0);
	lobby.state = _lobby_join_searching;
	lobby.seconds = 0.0f;
	lobby.team_set = FALSE;
	platform_log("lobby: searching for the host's game");
	lobby_phase(_phase_joining, NULL);
}

/* network_test.c's join steps: the first game the search finds (the host's:
the invite links to it alone), its lobby, then a team */
static void lobby_update_joining(real seconds)
{
	lobby.seconds += seconds;
	if (lobby.state == _lobby_join_searching)
	{
		if (network_game_client_join_first_available_game())
		{
			ui_widgets_close_all();
			ui_widget_load_by_name_or_tag(strcmp(config_string("display.menus"), "pc") ?
				XBOX_LOBBY_SCREEN : PC_LOBBY_SCREEN, NONE, NULL, NONE, NONE, NONE, NONE);
			lobby.state = _lobby_joined;
			lobby.seconds = 0.0f;
			platform_log("lobby: joining the host's game");
			lobby_phase(_phase_joined, NULL);
		}
		else if (lobby.seconds >= JOIN_SEARCH_TIME)
		{
			lobby.state = _lobby_idle;
			lobby_phase(_phase_failed, "The host's game was not found");
		}
	}
	/* (the other team from the host's player: a team game needs both) */
	else if (!lobby.team_set && lobby.seconds >= JOIN_TEAM_TIME)
		lobby.team_set = network_game_client_set_team(NONE);
}

static void web_lobby_update(boolean main_menu_loaded, real seconds)
{
	lobby_watch_main_menu(main_menu_loaded);
	lobby_take_request();
	switch (lobby.state)
	{
	case _lobby_waiting:
		if (main_menu_loaded)
			lobby_start_joining();
		break;
	case _lobby_join_searching:
	case _lobby_joined:
		lobby_update_joining(seconds);
		break;
	}
}

/* main.c's, once a frame (tools/web_build.py renames its call) */
void web_frame_update(boolean main_menu_loaded, real seconds)
{
	network_test_update(main_menu_loaded, seconds);
	web_lobby_update(main_menu_loaded, seconds);
}
