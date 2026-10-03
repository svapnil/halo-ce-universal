/*
WEB_LOBBY.C

The browser build's online games, as the page offers them (app/src/lobby.js,
App.jsx; NETWORK.md, "The lobby"): the page shows its own Multiplayer menu
when the game's opens, and asks the game to host a game (a map and a game
type: it starts at once, and the friends the page invites join it in
progress; or it waits in the game's lobby for them, until the host starts
it) or to join the game of the host the page has linked to.

It runs on the game's thread, once a frame: tools/web_build.py renames
main.c's call of port/linux/game/network_test.c's network_test_update to
web_frame_update, which calls it and then this. Hosting and joining are
network_test.c's own steps (the fast setup of a server; the first game the
search finds), so that both take the paths the netcode's tests take.

The page and the game share a mailbox (struct web_lobby_mailbox): the page
writes a request and raises request_sequence; the game writes its phase
and raises and notifies event_sequence (Atomics.waitAsync on the page).
ui_widget.c tells it which screen opens (web_ui_widget_launching), as the
game's menus have no other sign of it.
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
#include "game/game_engine.h"

#include <emscripten/emscripten.h>
#include <stdio.h>
#include <string.h>

void network_test_update(boolean main_menu_loaded, real seconds);
/* (port/linux/src/platform.h's, which the game's units do not include) */
void platform_log(char const *format, ...);

enum
{
	MAILBOX_MAGIC = 0x4C4F4259,
	MAILBOX_VERSION = 2,
	NAME_SIZE = 32,
	MESSAGE_SIZE = 128,
};

/* the page's requests */
enum
{
	_request_none = 0,
	_request_host,
	_request_join,
	/* the host's game, waiting in the lobby, starts */
	_request_start,
};

/* a host request's options */
enum
{
	_option_start_now = 1 << 0,
};

/* the game's phases, as the page reads them */
enum
{
	_phase_other = 0,
	_phase_main_menu,
	_phase_multiplayer_menu,
	_phase_starting,
	_phase_hosting,
	_phase_joining,
	_phase_joined,
	_phase_failed,
	/* hosting, in the lobby: the game waits for the host to start it */
	_phase_lobby,
};

struct web_lobby_mailbox
{
	unsigned int magic;
	unsigned int version;
	/* the page's */
	unsigned int request_sequence;
	unsigned int request;
	char map[NAME_SIZE];
	char variant[NAME_SIZE];
	unsigned int options;
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
	/* a request that waits for the main menu */
	_lobby_waiting,
	_lobby_host_setup,
	/* in the lobby, until the host starts the game */
	_lobby_host_waiting,
	_lobby_hosting,
	_lobby_join_searching,
	_lobby_joined,
};

/* (seconds) */
#define HOST_MAP_TIME 1.0f
#define HOST_PLAYER_TIME 2.0f
#define HOST_START_TIME 3.0f
#define JOIN_SEARCH_TIME 30.0f
#define JOIN_TEAM_TIME 5.0f

static struct
{
	int state;
	unsigned int seen_request;
	unsigned int request;
	char map[NAME_SIZE];
	char variant[NAME_SIZE];
	boolean start_now;
	real seconds;
	boolean map_set;
	boolean player_added;
	boolean team_set;
} lobby;

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
it, and remember it in z:\lastprof.txt (saved_game_files.c), but the page's
lobby goes around them: so the lobby takes the profile the player last used,
from that file, when none is active (as after a reload: the saves persist,
web_main.c), and records the active one there for the next visit. */
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

/* ui_widget.c's: a screen opens */
void web_ui_widget_launching(char const *name)
{
	if (!name)
		return;
	if (!strcmp(name, "ui\\shell\\main_menu\\multiplayer_type_select\\multiplayer_type_select_screen"))
		lobby_phase(_phase_multiplayer_menu, NULL);
	else if (!strcmp(name, "ui\\shell\\main_menu\\main_menu"))
	{
		/* (back at the main menu: a game hosted or joined is over) */
		if (lobby.state == _lobby_hosting || lobby.state == _lobby_host_waiting || lobby.state == _lobby_joined)
			lobby.state = _lobby_idle;
		/* (a profile picked or made in the game's menus is remembered as soon
		as the player is back here, not only when a campaign starts) */
		if (player_ui_get_active_player_profile_index(0) != NONE)
			player_ui_remember_player1_profile(TRUE);
		lobby_phase(_phase_main_menu, NULL);
	}
}

/* a name of letters, digits and _ only (the page's, checked again) */
static boolean plain_name(char const *name)
{
	if (!*name)
		return FALSE;
	for (; *name; name++)
	{
		if (!((*name >= 'a' && *name <= 'z') || (*name >= '0' && *name <= '9') || *name == '_'))
			return FALSE;
	}
	return TRUE;
}

static void lobby_start_game(void)
{
	network_game_client_request_immediate_start();
	lobby.state = _lobby_hosting;
	platform_log("lobby: starting the game");
	lobby_phase(_phase_hosting, NULL);
}

static void lobby_take_request(void)
{
	unsigned int sequence = __atomic_load_n(&mailbox.request_sequence, __ATOMIC_ACQUIRE);

	if (sequence == lobby.seen_request)
		return;
	lobby.seen_request = sequence;
	/* (the host starts the game that waits in the lobby) */
	if (mailbox.request == _request_start)
	{
		if (lobby.state == _lobby_host_waiting)
			lobby_start_game();
		return;
	}
	/* (one at a time: a game being set up finishes first) */
	if (lobby.state != _lobby_idle && lobby.state != _lobby_hosting && lobby.state != _lobby_joined)
		return;
	lobby.request = mailbox.request;
	lobby.start_now = (mailbox.options & _option_start_now) != 0;
	snprintf(lobby.map, sizeof(lobby.map), "%.*s", NAME_SIZE - 1, mailbox.map);
	snprintf(lobby.variant, sizeof(lobby.variant), "%.*s", NAME_SIZE - 1, mailbox.variant);
	if (lobby.request == _request_host && (!plain_name(lobby.map) || !plain_name(lobby.variant)))
	{
		lobby_phase(_phase_failed, "That map or game type is not one the game has");
		return;
	}
	if (lobby.request == _request_host || lobby.request == _request_join)
		lobby.state = _lobby_waiting;
}

static void lobby_start_hosting(void)
{
	lobby_use_player1_profile();
	main_set_multiplayer_map_name(lobby.map);
	player_ui_fast_setup_network_server();
	lobby.state = _lobby_host_setup;
	lobby.seconds = 0.0f;
	lobby.map_set = FALSE;
	lobby.player_added = FALSE;
	platform_log("lobby: hosting %s, %s%s", lobby.map, lobby.variant, lobby.start_now ? "" : " (waiting for friends)");
	lobby_phase(_phase_starting, NULL);
}

/* network_test.c's host steps: the map and game type (the fast setup clears
them), the player of controller 1, then the start (or the lobby, where the
host starts it: the game's own Start, or the page's) */
static void lobby_update_hosting(real seconds)
{
	struct network_game_server *server = global_network_game_server_get();

	lobby.seconds += seconds;
	if (!server)
	{
		lobby.state = _lobby_idle;
		lobby_phase(_phase_failed, "The game could not be hosted");
		return;
	}
	if (!lobby.map_set && lobby.seconds >= HOST_MAP_TIME)
	{
		char path[128];
		struct game_variant variant;
		struct game_variant *found;

		snprintf(path, sizeof(path), "levels\\test\\%s\\%s", lobby.map, lobby.map);
		network_game_server_change_map_name(server, path);
		found = game_engine_get_variant_by_name(&variant, lobby.variant);
		if (found)
		{
			variant = *found;
			player_ui_set_game_variant(&variant);
			network_game_server_change_game_variant(server, &variant);
		}
		lobby.map_set = TRUE;
	}
	if (!lobby.player_added && lobby.seconds >= HOST_PLAYER_TIME && global_network_game_client_get())
		lobby.player_added = network_game_client_add_player(global_network_game_client_get(), 0);
	if (lobby.player_added && lobby.seconds >= HOST_START_TIME)
	{
		if (lobby.start_now)
			lobby_start_game();
		else
		{
			lobby.state = _lobby_host_waiting;
			platform_log("lobby: waiting for friends");
			lobby_phase(_phase_lobby, NULL);
		}
	}
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
the page links to it alone), then a team */
static void lobby_update_joining(real seconds)
{
	lobby.seconds += seconds;
	if (lobby.state == _lobby_join_searching)
	{
		if (network_game_client_join_first_available_game())
		{
			ui_widgets_close_all();
			ui_widget_load_by_name_or_tag(
				"ui\\shell\\main_menu\\multiplayer_type_select\\connected\\pregame\\connected_pregame_screen",
				NONE, NULL, NONE, NONE, NONE, NONE);
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
	lobby_take_request();
	switch (lobby.state)
	{
	case _lobby_waiting:
		if (main_menu_loaded)
		{
			if (lobby.request == _request_host)
				lobby_start_hosting();
			else
				lobby_start_joining();
		}
		break;
	case _lobby_host_setup:
		lobby_update_hosting(seconds);
		break;
	case _lobby_host_waiting:
		/* (the game's own Start started it: the main menu's scenario is gone) */
		if (!main_menu_loaded)
		{
			lobby.state = _lobby_hosting;
			platform_log("lobby: the game started");
			lobby_phase(_phase_hosting, NULL);
		}
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
