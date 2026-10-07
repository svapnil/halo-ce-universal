# The lobby's chat (NETWORK.md, "The lobby's chat"): what the pages say,
# to every page with the site open (Signalling.Online's WebSockets, the
# topic "chat"), and the last 50 for a page that comes. In memory: a
# restart forgets them.
#
# A message that is a game's invite and nothing else (a host's page says
# its own as its game starts) is a game card: the room's game as it is now,
# told the pages again as it changes ({:card, room, card}: at most once a
# second for a room), and as it ends (NETWORK.md, "Game cards").
defmodule Signalling.Chat do
  @moduledoc false
  use GenServer

  alias Signalling.ChatFilter

  @topic "chat"
  @kept 50
  @longest_name 11
  @longest_text 200
  @default_name "New001"
  # at most one card update a second for a room
  @card_every 1_000
  # an invite, alone: a link's (https://<site>/#join=<room>.<secret>), or
  # its fragment
  @invite ~r/^(?:https?:\/\/[^\s#]*)?#join=([0-9A-HJKMNP-TV-Z]{8})\.([A-Za-z0-9_-]{22})$/i

  # the player colours of a multiplayer game, in the game's order: a
  # visitor's is one of them, by its id, the same at every visit
  @colors ~w(white black red blue gray yellow green pink purple cyan cobalt
             orange teal sage brown tan maroon salmon)

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  # the pages' topic: {:chat, message}
  def topic, do: @topic

  # the last messages, oldest first
  def history, do: GenServer.call(__MODULE__, :history)

  # a page says text (already its own: name/1, text/1, color/1). With a
  # blocked word (Signalling.ChatFilter) in the text or the name, only the
  # page is told: to it the message is said, with an id of its own, and the
  # others see nothing, nor does the history keep it
  def say(name, color, text) do
    to = if ChatFilter.blocked?(text) or ChatFilter.blocked?(name), do: self(), else: :all
    GenServer.cast(__MODULE__, {:say, name, color, text, to})
  end

  # the room and secret of a message that is an invite and nothing else, or
  # nil
  def invite(text) when is_binary(text) do
    case Regex.run(@invite, text) do
      [_, room, secret] -> {String.upcase(room), secret}
      nil -> nil
    end
  end

  def invite(_), do: nil

  # a page says a game's invite, whose room is `room` (Signalling.Room.card:
  # its pid and state): a card of it. `started`: the host's page says it
  # as its game starts (else a player shares it). A blocked word in the
  # name: only the page is told, as say/3
  def share(name, color, text, {code, secret}, room, state, started) do
    to = if ChatFilter.blocked?(name), do: self(), else: :all

    GenServer.cast(
      __MODULE__,
      {:share, name, color, text, code, secret, room, state, started, to}
    )
  end

  # a carded room as it is now (Signalling.Room's changed)
  def room_changed(code, state), do: GenServer.cast(__MODULE__, {:room, code, state})

  def color(visitor), do: Enum.at(@colors, :erlang.phash2(visitor, length(@colors)))

  # a profile's name as a page gives it: at most 11 characters (the game's),
  # no control characters; the game's first default, if none
  def name(text) when is_binary(text) do
    case text |> clean() |> String.slice(0, @longest_name) |> String.trim() do
      "" -> @default_name
      name -> name
    end
  end

  def name(_), do: @default_name

  # a message's text: at most 200 characters, on one line; nil if empty
  def text(text) when is_binary(text) do
    case text |> clean() |> String.trim() |> String.slice(0, @longest_text) do
      "" -> nil
      text -> text
    end
  end

  def text(_), do: nil

  defp clean(text) do
    if String.valid?(text), do: String.replace(text, ~r/[\p{C}]+/u, " "), else: ""
  end

  # cards: room code => the card as it is now; rooms: a carded room's pid
  # => {its code, its monitor} (its end ends the card); told: room code => when
  # its card was last told the pages (monotonic ms), and pending: room codes
  # whose change waits to be told
  @impl true
  def init(_),
    do:
      {:ok,
       %{
         next: 1,
         messages: :queue.new(),
         count: 0,
         cards: %{},
         rooms: %{},
         told: %{},
         pending: MapSet.new()
       }}

  @impl true
  def handle_call(:history, _from, state),
    do: {:reply, Enum.map(:queue.to_list(state.messages), &with_card(&1, state)), state}

  @impl true
  def handle_cast({:say, name, color, text, to}, state) do
    {:noreply, said(state, message(state, name, color, text), to)}
  end

  def handle_cast({:share, name, color, text, code, secret, room, room_state, started, to}, state) do
    state =
      if Map.has_key?(state.rooms, room) do
        state
      else
        %{state | rooms: Map.put(state.rooms, room, {code, Process.monitor(room)})}
      end

    state = %{state | cards: Map.put(state.cards, code, card(room_state))}

    message =
      state
      |> message(name, color, text)
      |> Map.merge(%{card: %{room: code, secret: secret}, started: started == true})

    {:noreply, said(state, message, to)}
  end

  def handle_cast({:room, code, room_state}, state) do
    if Map.has_key?(state.cards, code) do
      state = %{state | cards: Map.put(state.cards, code, card(room_state))}
      {:noreply, tell_soon(state, code)}
    else
      {:noreply, state}
    end
  end

  @impl true
  # a carded room ends: so does its card, told at once
  def handle_info({:DOWN, _, :process, room, _}, state) do
    case Map.pop(state.rooms, room) do
      {nil, _} ->
        {:noreply, state}

      {{code, _}, rooms} ->
        ended =
          state.cards
          |> Map.get(code, %{})
          |> Map.merge(%{status: "ended", endedAt: now(), inProgress: false, host: nil})

        state = %{state | rooms: rooms, cards: Map.put(state.cards, code, ended)}
        {:noreply, tell(state, code)}
    end
  end

  def handle_info({:tell, code}, state) do
    if MapSet.member?(state.pending, code),
      do: {:noreply, tell(state, code)},
      else: {:noreply, state}
  end

  def handle_info(_, state), do: {:noreply, state}

  # a message to a page (blocked: its own) or to all, kept
  defp said(state, message, page) when is_pid(page) do
    send(page, {:chat, with_card(message, state)})
    %{state | next: state.next + 1}
  end

  defp said(state, message, :all) do
    Phoenix.PubSub.local_broadcast(Signalling.PubSub, @topic, {:chat, with_card(message, state)})
    messages = :queue.in(message, state.messages)

    {messages, count} =
      if state.count >= @kept,
        do: {:queue.drop(messages), state.count},
        else: {messages, state.count + 1}

    forget_cards(%{state | next: state.next + 1, messages: messages, count: count})
  end

  defp message(state, name, color, text),
    do: %{id: state.next, name: name, color: color, text: text, at: System.os_time(:second)}

  # a card message as the pages get it: the room's game as it is now
  defp with_card(%{card: %{room: code} = card} = message, state),
    do: %{message | card: Map.merge(Map.get(state.cards, code, %{}), card)}

  defp with_card(message, _), do: message

  # what a card shows of a room's state (Signalling.Room's): the game's
  # name only without a blocked word (the host types it)
  defp card(room) do
    game = room.game || %{}
    name = game[:name]

    %{
      status: "live",
      host: room.host,
      machines: room.machines,
      matches: room.matches,
      matchStartedAt: room.match_started_at,
      createdAt: room.created_at,
      endedAt: nil,
      name: if(is_binary(name) and name != "" and not ChatFilter.blocked?(name), do: name),
      map: game[:map],
      gametype: game[:gametype],
      engine: game[:engine],
      players: game[:players],
      maximumPlayers: game[:maximum_players],
      inProgress: game[:in_progress] == true,
      open: game[:open],
      teams: game[:teams]
    }
  end

  # a room's card to the pages: now, or once a second has passed since the
  # last
  defp tell_soon(state, code) do
    # (monotonic time may be below zero: nil, never told)
    told = Map.get(state.told, code)
    since = if told, do: System.monotonic_time(:millisecond) - told

    cond do
      MapSet.member?(state.pending, code) ->
        state

      since == nil or since >= @card_every ->
        tell(state, code)

      true ->
        Process.send_after(self(), {:tell, code}, @card_every - since)
        %{state | pending: MapSet.put(state.pending, code)}
    end
  end

  defp tell(state, code) do
    Phoenix.PubSub.local_broadcast(
      Signalling.PubSub,
      @topic,
      {:card, code, Map.get(state.cards, code)}
    )

    %{
      state
      | told: Map.put(state.told, code, System.monotonic_time(:millisecond)),
        pending: MapSet.delete(state.pending, code)
    }
  end

  # the cards no kept message shows any more are let go (and their rooms)
  defp forget_cards(state) do
    shown =
      state.messages
      |> :queue.to_list()
      |> Enum.flat_map(fn
        %{card: %{room: code}} -> [code]
        _ -> []
      end)
      |> MapSet.new()

    gone = state.cards |> Map.keys() |> Enum.reject(&MapSet.member?(shown, &1))

    if gone == [] do
      state
    else
      rooms =
        state.rooms
        |> Enum.reject(fn {_, {code, monitor}} ->
          code in gone and Process.demonitor(monitor, [:flush])
        end)
        |> Map.new()

      %{
        state
        | cards: Map.drop(state.cards, gone),
          told: Map.drop(state.told, gone),
          pending: Enum.reduce(gone, state.pending, &MapSet.delete(&2, &1)),
          rooms: rooms
      }
    end
  end

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
end
