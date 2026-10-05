# One hosted game: its host's page and its joiners', whose ends it sees
# (it monitors them). It ends when its host's page does: links already made
# keep working (they are the SFU's), but no one else can join.
defmodule Signalling.Room do
  @moduledoc false
  use GenServer, restart: :temporary

  alias Signalling.SFU

  # 16 machines: the browser host has a page's bandwidth, not a server's
  @maximum_joiners 15
  @code_alphabet ~c"0123456789ABCDEFGHJKMNPQRSTVWXYZ"

  # a new room's code: 8 characters of Crockford's base 32
  def new_code do
    for <<byte <- :crypto.strong_rand_bytes(8)>>,
      into: "",
      do: <<Enum.at(@code_alphabet, rem(byte, 32))>>
  end

  def code?(text), do: text =~ ~r/^[0-9A-HJKMNP-TV-Z]{8}$/

  # ---------- what a page asks of it

  # the calling page hosts a new room: {:ok, room, its secret}
  def open(code, id, net_version) do
    secret = Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)
    room = %{code: code, secret: secret, id: id, net_version: net_version, host: self()}

    case DynamicSupervisor.start_child(Signalling.RoomSupervisor, {__MODULE__, room}) do
      {:ok, pid} -> {:ok, pid, secret}
      {:error, _} -> {:error, "protocol", "The room already has a host"}
    end
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
    Process.monitor(room.host)
    # joiners: page => %{peer, id, net_version, monitor, channels}
    {:ok, Map.merge(room, %{session: nil, ready: false, joiners: %{}})}
  end

  @impl true
  def handle_call({:join, page, id, net_version, secret}, _from, room) do
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
          channels: nil
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

      joiner ->
        link = %{type: "link", peer: joiner.peer, id: joiner.id, netVersion: joiner.net_version}
        send(room.host, {:push, Map.merge(link, channels)})
        {:reply, :ok, put_in(room.joiners[page].channels, Map.values(channels))}
    end
  end

  @impl true
  def handle_cast({:host_session, session}, room), do: {:noreply, %{room | session: session}}
  def handle_cast(:host_ready, room), do: {:noreply, %{room | ready: true}}

  def handle_cast({:drop, from, peer}, room) do
    case Enum.find(room.joiners, fn {_, joiner} -> from == room.host and joiner.peer == peer end) do
      {page, _} ->
        send(page, {:fail, "dropped", "The host dropped this machine"})
        {:noreply, remove(room, page, "dropped")}

      nil ->
        {:noreply, room}
    end
  end

  def handle_cast({:gone, page, reason}, room), do: {:noreply, remove(room, page, reason)}

  @impl true
  def handle_info({:DOWN, _, :process, page, _}, %{host: page} = room) do
    for {joiner, _} <- room.joiners do
      send(joiner, {:fail, "closed", "The host left"})
    end

    {:stop, :normal, room}
  end

  def handle_info({:DOWN, _, :process, page, _}, room), do: {:noreply, remove(room, page, "left")}

  # a joiner ends: if its link was made, the host is told, and the host's
  # channels of it are closed
  defp remove(room, page, reason) do
    case Map.pop(room.joiners, page) do
      {nil, _} ->
        room

      {joiner, joiners} ->
        Process.demonitor(joiner.monitor, [:flush])

        if joiner.channels do
          send(room.host, {:push, %{type: "unlink", peer: joiner.peer, reason: reason}})
          session = room.session
          channels = for id <- joiner.channels, do: %{id: id}

          Task.Supervisor.start_child(Signalling.Tasks, fn ->
            SFU.request(:put, "/sessions/#{session}/datachannels/close", %{dataChannels: channels})
          end)
        end

        %{room | joiners: joiners}
    end
  end
end
