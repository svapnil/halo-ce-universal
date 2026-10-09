# One hosted game: its host's page and its joiners', whose ends it sees
# (it monitors them). It ends when its host's page leaves (the page closes
# its WebSocket): links already made keep working (they are the SFU's), but
# no one else can join. A host's page whose WebSocket is lost (a network
# blip, a server restart) comes back to it (rehost), with its host key: the
# room waits for it a while (:host_grace), and a room the server no longer
# has (it restarted) is made again, with the same code and secret
# (NETWORK.md, "Rooms and invites").
defmodule Signalling.Room do
  @moduledoc false
  use GenServer, restart: :temporary

  alias Signalling.SFU

  # 16 machines, as the game's 16 players at most (NETWORK.md, "How it
  # differs from upstream's", row 18): a player to a page, the host's
  # included. The host's page carries a link to each, through the SFU
  @maximum_joiners 15
  @code_alphabet ~c"0123456789ABCDEFGHJKMNPQRSTVWXYZ"

  # a new room's code: 8 characters of Crockford's base 32
  def new_code do
    for <<byte <- :crypto.strong_rand_bytes(8)>>,
      into: "",
      do: <<Enum.at(@code_alphabet, rem(byte, 32))>>
  end

  def code?(text), do: text =~ ~r/^[0-9A-HJKMNP-TV-Z]{8}$/

  def maximum_joiners, do: @maximum_joiners

  # ---------- what a page asks of it

  # the calling page hosts a new room: {:ok, room, its secret, its host key}
  def open(code, id, net_version) do
    host_key = Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)
    secret = secret(code, host_key)
    room = %{code: code, secret: secret, id: id, net_version: net_version, host: self()}

    case DynamicSupervisor.start_child(Signalling.RoomSupervisor, {__MODULE__, room}) do
      {:ok, pid} -> {:ok, pid, secret, host_key}
      {:error, _} -> {:error, "protocol", "The room already has a host"}
    end
  end

  # the invite's secret, from the host key that only the host has: so that
  # a room the server no longer has can be made again by its host, and by
  # no joiner (each has the secret, which does not give the key)
  defp secret(code, host_key) do
    :crypto.hash(:sha256, "halo-room-v1:#{code}:#{host_key}")
    |> binary_part(0, 16)
    |> Base.url_encode64(padding: false)
  end

  def host_key?(text), do: is_binary(text) and text =~ ~r/^[A-Za-z0-9_-]{22}$/

  # the calling page is the host of room `code` again, whose links are
  # `peers` (%{peer, id}) and SFU session `session`: the room it had, or
  # the same made again. {:ok, room, its secret}
  def rehost(code, host_key, id, net_version, session, peers) do
    secret = secret(code, host_key)
    request = {:rehost, self(), secret, id, net_version, session, peers}

    room =
      case Registry.lookup(Signalling.Rooms, code) do
        [{room, _}] ->
          room

        [] ->
          again = %{code: code, secret: secret, id: id, net_version: net_version, host: nil}

          case DynamicSupervisor.start_child(Signalling.RoomSupervisor, {__MODULE__, again}) do
            {:ok, room} -> room
            {:error, {:already_started, room}} -> room
            {:error, _} -> nil
          end
      end

    with room when is_pid(room) <- room,
         {:ok, :ok} <- call(room, request) do
      {:ok, room, secret}
    else
      {:ok, {:error, _, _} = error} -> error
      _ -> {:error, "not-found", "No such game"}
    end
  end

  # the calling host's page leaves the room (it closed its WebSocket): the
  # room ends at once, without waiting for it
  def host_left(room), do: GenServer.cast(room, {:host_left, self()})

  # the calling host's page tells of its game as it is now (Page's
  # check_game: name, map, gametype, engine, open, in_progress, teams,
  # players, maximum_players)
  def game(room, game), do: GenServer.cast(room, {:game, self(), game})

  # the room `code` as it is now, if `secret` is its invite's: {:ok, room,
  # state} (as /stats has it), or :error. The room then tells the lobby's
  # chat of each change (Signalling.Chat.room_changed), for the chat's game
  # cards (NETWORK.md, "Game cards")
  def card(code, secret) do
    with true <- is_binary(secret),
         [{room, _}] <- Registry.lookup(Signalling.Rooms, code),
         {:ok, {:ok, state}} <- call(room, {:card, secret}) do
      {:ok, room, state}
    else
      _ -> :error
    end
  end

  # every room as it is now (NETWORK.md, "The room's game"): the server's
  # /stats. (A room that does not answer at once is left out)
  def all do
    Registry.select(Signalling.Rooms, [{{:_, :"$1", :_}, [], [:"$1"]}])
    |> Task.async_stream(&GenServer.call(&1, :state, 1000),
      timeout: 2000,
      on_timeout: :kill_task,
      ordered: false
    )
    |> Enum.flat_map(fn
      {:ok, state} -> [state]
      _ -> []
    end)
    |> Enum.sort_by(& &1.created_at)
  end

  # every room with a game and its host, as the Server Browser lists them
  # (Signalling.Games): with its invite, which its card has made public
  # already. (A room that does not answer at once is left out)
  def listings do
    Registry.select(Signalling.Rooms, [{{:_, :"$1", :_}, [], [:"$1"]}])
    |> Task.async_stream(&GenServer.call(&1, :listing, 1000),
      timeout: 2000,
      on_timeout: :kill_task,
      ordered: false
    )
    |> Enum.flat_map(fn
      {:ok, {:ok, listing}} -> [listing]
      _ -> []
    end)
    |> Enum.sort_by(& &1.createdAt)
  end

  # the calling page joins the room: {:ok, %{room, peer, host}}, the host's
  # id, net_version and SFU session
  def join(code, id, net_version, secret) do
    with [{room, _}] <- Registry.lookup(Signalling.Rooms, code),
         {:ok, answer} <- call(room, {:join, self(), id, net_version, secret}) do
      answer
    else
      _ -> {:error, "not-found", "No such game"}
    end
  end

  def host_session(room, session), do: GenServer.cast(room, {:host_session, session})
  def host_ready(room), do: GenServer.cast(room, :host_ready)

  # the calling joiner's link is made: the host is told of it. `channels` are
  # the host's two, by name
  def linked(room, channels) do
    case call(room, {:linked, self(), channels}) do
      {:ok, answer} -> answer
      :gone -> {:error, "closed", "The host left"}
    end
  end

  # the host ends a joiner's link
  def drop(room, peer), do: GenServer.cast(room, {:drop, self(), peer})

  # the calling joiner ends, for that reason ("failed"; a page that only
  # closes has "left")
  def gone(room, reason), do: GenServer.cast(room, {:gone, self(), reason})

  defp call(room, request) do
    {:ok, GenServer.call(room, request)}
  catch
    :exit, _ -> :gone
  end

  # ---------- the room

  def start_link(room) do
    GenServer.start_link(__MODULE__, room, name: {:via, Registry, {Signalling.Rooms, room.code}})
  end

  @impl true
  def init(room) do
    # (a room made again for a rehost waits for it as for a host that is away)
    grace =
      if room.host do
        Process.monitor(room.host)
        nil
      else
        wait()
      end

    # joiners: page => %{peer, id, net_version, monitor, channels, session};
    # one the server knows only from its host's rehost (it restarted) is
    # {:ghost, peer} => the same, with no monitor and no channels
    # game: what the host's page says of its game (nil until it does);
    # match_started_at: when its match started (nil between matches)
    {:ok,
     Map.merge(room, %{
       session: nil,
       ready: false,
       joiners: %{},
       grace: grace,
       created_at: now(),
       game: nil,
       game_updated_at: nil,
       match_started_at: nil,
       matches: 0,
       # whether the chat has a card of it (card/2)
       carded: false
     })}
  end

  @impl true
  def handle_call({:join, page, id, net_version, secret}, _from, room) do
    # (a machine that comes back, whose old link the server knows only from
    # its host: the old one is gone)
    room =
      if is_binary(secret) and Plug.Crypto.secure_compare(secret, room.secret) do
        case Enum.find(room.joiners, fn {key, joiner} -> ghost?(key) and joiner.id == id end) do
          {key, _} -> remove(room, key, "left")
          nil -> room
        end
      else
        room
      end

    taken = MapSet.new(Map.values(room.joiners), & &1.peer)
    peer = Enum.find(1..(@maximum_joiners + 1), &(&1 not in taken))

    refusal =
      cond do
        not (is_binary(secret) and Plug.Crypto.secure_compare(secret, room.secret)) ->
          {"secret", "The invite is not this game's"}

        net_version != room.net_version ->
          {"version",
           "The host plays network version #{room.net_version}, this page #{net_version}"}

        not room.ready ->
          {"not-ready", "The host is still connecting"}

        room.host == nil ->
          {"not-ready", "The host is reconnecting"}

        id == room.id or Enum.any?(Map.values(room.joiners), &(&1.id == id)) ->
          {"duplicate", "A machine with this identifier is already in the game"}

        peer > @maximum_joiners ->
          {"full", "The game is full"}

        true ->
          nil
      end

    case refusal do
      {code, message} ->
        {:reply, {:error, code, message}, room}

      nil ->
        joiner = %{
          peer: peer,
          id: id,
          net_version: net_version,
          monitor: Process.monitor(page),
          channels: nil,
          session: nil
        }

        host = %{id: room.id, net_version: room.net_version, session: room.session}

        {:reply, {:ok, %{room: self(), peer: peer, host: host}},
         put_in(room.joiners[page], joiner)}
    end
  end

  def handle_call({:linked, page, channels}, _from, room) do
    case room.joiners[page] do
      nil ->
        {:reply, {:error, "dropped", "The host dropped this machine"}, room}

      _ when room.host == nil ->
        {:reply, {:error, "not-ready", "The host is reconnecting"}, room}

      joiner ->
        link = %{type: "link", peer: joiner.peer, id: joiner.id, netVersion: joiner.net_version}
        send(room.host, {:push, Map.merge(link, channels)})
        joiner = %{joiner | channels: Map.values(channels), session: room.session}
        {:reply, :ok, changed(put_in(room.joiners[page], joiner))}
    end
  end

  def handle_call(:state, _from, room), do: {:reply, state(room), room}
  def handle_call(:listing, _from, room), do: {:reply, listing(room), room}

  def handle_call({:card, secret}, _from, room) do
    if Plug.Crypto.secure_compare(secret, room.secret) do
      {:reply, {:ok, state(room)}, %{room | carded: true}}
    else
      {:reply, :error, room}
    end
  end

  def handle_call({:rehost, page, secret, id, net_version, session, peers}, _from, room) do
    cond do
      not (Plug.Crypto.secure_compare(secret, room.secret) and id == room.id) ->
        {:reply, {:error, "secret", "Not this game's host"}, room}

      net_version != room.net_version ->
        {:reply, {:error, "version", "The room is of network version #{room.net_version}"}, room}

      true ->
        # (a page the server still takes for the host, whose WebSocket is
        # gone but not yet seen to be: the new one replaces it)
        if room.host && room.host != page do
          send(room.host, {:fail, "replaced", "This game's host connected again"})
        end

        if room.host != page, do: Process.monitor(page)

        {:reply, :ok,
         room
         |> Map.merge(%{host: page, session: session, ready: true, grace: nil})
         |> reconcile(peers)
         |> changed()}
    end
  end

  @impl true
  def handle_cast({:host_session, session}, room), do: {:noreply, %{room | session: session}}
  def handle_cast(:host_ready, room), do: {:noreply, %{room | ready: true}}

  def handle_cast({:drop, from, peer}, room) do
    case Enum.find(room.joiners, fn {_, joiner} -> from == room.host and joiner.peer == peer end) do
      {page, _} ->
        if is_pid(page), do: send(page, {:fail, "dropped", "The host dropped this machine"})
        {:noreply, remove(room, page, "dropped")}

      nil ->
        {:noreply, room}
    end
  end

  def handle_cast({:gone, page, reason}, room), do: {:noreply, remove(room, page, reason)}

  def handle_cast({:game, page, game}, %{host: page} = room) do
    was = room.game != nil and room.game.in_progress

    {started, matches} =
      cond do
        game.in_progress and not was -> {now(), room.matches + 1}
        game.in_progress -> {room.match_started_at, room.matches}
        true -> {nil, room.matches}
      end

    {:noreply,
     changed(%{
       room
       | game: game,
         game_updated_at: now(),
         match_started_at: started,
         matches: matches
     })}
  end

  def handle_cast({:game, _, _}, room), do: {:noreply, room}

  def handle_cast({:host_left, page}, %{host: page} = room), do: close(room)
  def handle_cast({:host_left, _}, room), do: {:noreply, room}

  @impl true
  # the host's page ended without leaving (its WebSocket was lost): the
  # room waits for it to come back, if it had ever reached the SFU
  def handle_info({:DOWN, _, :process, page, _}, %{host: page, ready: true} = room) do
    {:noreply, changed(%{room | host: nil, grace: wait()})}
  end

  def handle_info({:DOWN, _, :process, page, _}, %{host: page} = room), do: close(room)
  def handle_info({:DOWN, _, :process, page, _}, room), do: {:noreply, remove(room, page, "left")}

  def handle_info({:grace, grace}, %{grace: grace} = room), do: close(room)
  def handle_info(_, room), do: {:noreply, room}

  # the room ends: its joiners are told, and their links left as they are
  defp close(room) do
    for {joiner, _} <- room.joiners, is_pid(joiner) do
      send(joiner, {:fail, "closed", "The host left"})
    end

    Signalling.Games.changed()
    {:stop, :normal, room}
  end

  # the room as the Server Browser lists it (Signalling.Games): {:ok, it},
  # or :none without a game yet or while its host is away. The game's name
  # only without a blocked word (the host types it), as the chat's cards
  defp listing(%{game: game, host: host} = room) when game != nil and host != nil do
    joiners = Map.values(room.joiners)
    name = game[:name]

    {:ok,
     %{
       room: room.code,
       secret: room.secret,
       hostId: room.id,
       netVersion: room.net_version,
       createdAt: room.created_at,
       machines: 1 + Enum.count(joiners, &(&1.channels || &1.monitor == nil)),
       name:
         if(is_binary(name) and name != "" and not Signalling.ChatFilter.blocked?(name),
           do: name,
           else: ""
         ),
       map: game[:map],
       gametype: game[:gametype],
       engine: game[:engine],
       players: game[:players],
       maximumPlayers: game[:maximum_players],
       open: game[:open] == true,
       inProgress: game[:in_progress] == true,
       teams: game[:teams] == true
     }}
  end

  defp listing(_), do: :none

  # the room as /stats and the chat's cards have it
  defp state(room) do
    joiners = Map.values(room.joiners)

    %{
      room: room.code,
      created_at: room.created_at,
      host: if(room.host, do: "connected", else: "reconnecting"),
      net_version: room.net_version,
      # the machines in the room: the host and its linked joiners (a ghost:
      # one the room knows from its host's rehost)
      machines: 1 + Enum.count(joiners, &(&1.channels || &1.monitor == nil)),
      joining: Enum.count(joiners, &(&1.channels == nil and &1.monitor != nil)),
      game: room.game,
      game_updated_at: room.game_updated_at,
      match_started_at: room.match_started_at,
      matches: room.matches
    }
  end

  # tells the Server Browser's list (Signalling.Games) of the room as it is
  # now, and the chat, if the chat has a card of it (each lets most go: at
  # most one a second reaches pages)
  defp changed(room) do
    Signalling.Games.changed()
    if room.carded, do: Signalling.Chat.room_changed(room.code, state(room))
    room
  end

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()

  # how long a room waits for its host to come back
  defp wait do
    grace = make_ref()
    Process.send_after(self(), {:grace, grace}, Application.fetch_env!(:signalling, :host_grace))
    grace
  end

  defp ghost?(key), do: match?({:ghost, _}, key)

  # the room's joiners as the host that came back has them: a linked joiner
  # it no longer has (its link ended while the host was away) is gone, and
  # one the room does not know of (the server restarted) is a ghost, which
  # keeps its number and its id until its link ends
  defp reconcile(room, peers) do
    kept = MapSet.new(peers, & &1.peer)

    room =
      Enum.reduce(room.joiners, room, fn {key, joiner}, room ->
        if joiner.channels && joiner.peer not in kept do
          if is_pid(key), do: send(key, {:fail, "dropped", "The link to the host ended"})
          remove(room, key, "failed")
        else
          room
        end
      end)

    known = MapSet.new(Map.values(room.joiners), & &1.peer)

    Enum.reduce(peers, room, fn %{peer: peer, id: id}, room ->
      if peer in known do
        room
      else
        ghost = %{
          peer: peer,
          id: id,
          net_version: room.net_version,
          monitor: nil,
          channels: nil,
          session: nil
        }

        put_in(room.joiners[{:ghost, peer}], ghost)
      end
    end)
  end

  # a joiner ends: if its link was made, the host is told, and the host's
  # channels of it are closed (a ghost's: the host's page told of its end,
  # or is told of it now)
  defp remove(room, page, reason) do
    case Map.pop(room.joiners, page) do
      {nil, _} ->
        room

      {joiner, joiners} ->
        if joiner.monitor, do: Process.demonitor(joiner.monitor, [:flush])

        if (joiner.channels || ghost?(page)) && room.host do
          send(room.host, {:push, %{type: "unlink", peer: joiner.peer, reason: reason}})
        end

        if joiner.channels do
          session = joiner.session || room.session
          channels = for id <- joiner.channels, do: %{id: id}

          Task.Supervisor.start_child(Signalling.Tasks, fn ->
            SFU.request(:put, "/sessions/#{session}/datachannels/close", %{dataChannels: channels})
          end)
        end

        changed(%{room | joiners: joiners})
    end
  end
end
