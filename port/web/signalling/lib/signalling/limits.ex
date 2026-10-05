# What an address may do: 5 rooms and 20 joins a minute (each is SFU sessions
# on the account's bill, as wrangler.toml's HOST_LIMIT and JOIN_LIMIT), and
# 32 pages at once (a page keeps its WebSocket for its whole game, and the
# machine's memory is the relay's too; SIGNALLING_PAGES_AT_ONCE).
defmodule Signalling.Limits do
  @moduledoc false
  use GenServer

  @table __MODULE__
  @a_minute %{host: 5, join: 20}

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  # counts one more room (:host) or join (:join) of the address's in this
  # minute; false past the limit
  def allow?(kind, address) do
    key = {kind, address, minute()}
    :ets.update_counter(@table, key, 1, {key, 0}) <= Map.fetch!(@a_minute, kind)
  end

  # counts the calling page among its address's, until it ends
  def enter(address), do: GenServer.call(__MODULE__, {:enter, address, self()})

  defp minute, do: System.monotonic_time(:second) |> div(60)

  @impl true
  def init(_) do
    :ets.new(@table, [:named_table, :public, write_concurrency: true])
    Process.send_after(self(), :forget, 60_000)
    {:ok, %{counts: %{}, pages: %{}}}
  end

  @impl true
  def handle_call({:enter, address, page}, _from, state) do
    if Map.get(state.counts, address, 0) >= Application.fetch_env!(:signalling, :pages_at_once) do
      {:reply, :busy, state}
    else
      reference = Process.monitor(page)
      counts = Map.update(state.counts, address, 1, &(&1 + 1))
      {:reply, :ok, %{counts: counts, pages: Map.put(state.pages, reference, address)}}
    end
  end

  @impl true
  def handle_info({:DOWN, reference, :process, _, _}, state) do
    {address, pages} = Map.pop(state.pages, reference)

    counts =
      case Map.get(state.counts, address) do
        nil -> state.counts
        1 -> Map.delete(state.counts, address)
        count -> Map.put(state.counts, address, count - 1)
      end

    {:noreply, %{counts: counts, pages: pages}}
  end

  # the minutes past
  def handle_info(:forget, state) do
    :ets.select_delete(@table, [{{{:_, :_, :"$1"}, :_}, [{:<, :"$1", minute()}], [true]}])
    Process.send_after(self(), :forget, 60_000)
    {:noreply, state}
  end
end
