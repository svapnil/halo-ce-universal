# What an address may do: 5 rooms and 20 joins a minute (each is SFU sessions
# on the account's bill, as wrangler.toml's HOST_LIMIT and JOIN_LIMIT), and
# 32 pages at once (a page keeps its WebSocket for its whole game, and the
# machine's memory is the relay's too; SIGNALLING_PAGES_AT_ONCE). And the
# online count's WebSockets (Signalling.Online), one for each page open:
# 400 at once at most (SIGNALLING_ONLINE_AT_ONCE), so that they leave the
# rooms' pages the rest of the server's 800.
defmodule Signalling.Limits do
  @moduledoc false
  use GenServer

  @table __MODULE__
  # (and the lobby's chat: 20 messages a minute)
  @a_minute %{host: 5, join: 20, chat: 20}

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  # counts one more room (:host), join (:join) or chat message (:chat) of
  # the address's in this minute; false past the limit
  def allow?(kind, address) do
    key = {kind, address, minute()}
    :ets.update_counter(@table, key, 1, {key, 0}) <= Map.fetch!(@a_minute, kind)
  end

  # counts the calling page among its address's, until it ends: a room's
  # (:page) or the online count's (:online)
  def enter(address, kind \\ :page),
    do: GenServer.call(__MODULE__, {:enter, address, kind, self()})

  defp minute, do: System.monotonic_time(:second) |> div(60)

  @impl true
  def init(_) do
    :ets.new(@table, [:named_table, :public, write_concurrency: true])
    Process.send_after(self(), :forget, 60_000)
    {:ok, %{counts: %{}, pages: %{}, online: 0}}
  end

  @impl true
  def handle_call({:enter, address, kind, page}, _from, state) do
    cond do
      Map.get(state.counts, address, 0) >= Application.fetch_env!(:signalling, :pages_at_once) ->
        {:reply, :busy, state}

      kind == :online and state.online >= Application.fetch_env!(:signalling, :online_at_once) ->
        {:reply, :busy, state}

      true ->
        reference = Process.monitor(page)
        counts = Map.update(state.counts, address, 1, &(&1 + 1))
        online = if kind == :online, do: state.online + 1, else: state.online
        pages = Map.put(state.pages, reference, {address, kind})
        {:reply, :ok, %{counts: counts, pages: pages, online: online}}
    end
  end

  @impl true
  def handle_info({:DOWN, reference, :process, _, _}, state) do
    {{address, kind}, pages} = Map.pop(state.pages, reference)
    online = if kind == :online, do: state.online - 1, else: state.online

    counts =
      case Map.get(state.counts, address) do
        nil -> state.counts
        1 -> Map.delete(state.counts, address)
        count -> Map.put(state.counts, address, count - 1)
      end

    {:noreply, %{counts: counts, pages: pages, online: online}}
  end

  # the minutes past
  def handle_info(:forget, state) do
    :ets.select_delete(@table, [{{{:_, :_, :"$1"}, :_}, [{:<, :"$1", minute()}], [true]}])
    Process.send_after(self(), :forget, 60_000)
    {:noreply, state}
  end
end
