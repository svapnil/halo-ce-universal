# The browsers' games as the PC menus' Server Browser lists them (NETWORK.md,
# "Browsers' games in the server browser"): every room that has a game, with
# its invite, to every page with the site open (Signalling.Online's
# WebSockets, the topic "games"), as it connects and as any room changes, at
# most once a second. The pages write them into the game's memory, and the
# browser build's p2p_lobby_games lists them above the desktop builds'
# games, named [WEB] (port/web/src/web_p2p.c; app/src/game.js).
#
# The list is read from the rooms themselves each time (Signalling.Room.listings),
# so that it is whole after a restart, when the rooms are made again by
# their hosts. A room's invite is public already (its card in the lobby's
# chat carries it: Signalling.Chat), so this tells a page nothing new.
defmodule Signalling.Games do
  @moduledoc false
  use GenServer

  alias Signalling.Room

  @topic "games"
  # at most one list a second to the pages
  @every 1_000

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  # the pages' topic: {:games, list}
  def topic, do: @topic

  # the list as it is now (a page that connects)
  def current, do: Room.listings()

  # a room changed, or ended: the pages are told soon
  def changed, do: GenServer.cast(__MODULE__, :changed)

  @impl true
  def init(_), do: {:ok, %{told: nil, pending: false}}

  @impl true
  def handle_cast(:changed, state) do
    # (monotonic time may be below zero: nil, never told)
    since = if state.told, do: System.monotonic_time(:millisecond) - state.told

    cond do
      state.pending ->
        {:noreply, state}

      since == nil or since >= @every ->
        {:noreply, tell(state)}

      true ->
        Process.send_after(self(), :tell, @every - since)
        {:noreply, %{state | pending: true}}
    end
  end

  @impl true
  def handle_info(:tell, state), do: {:noreply, tell(state)}

  defp tell(state) do
    Phoenix.PubSub.local_broadcast(Signalling.PubSub, @topic, {:games, Room.listings()})
    %{state | told: System.monotonic_time(:millisecond), pending: false}
  end
end
