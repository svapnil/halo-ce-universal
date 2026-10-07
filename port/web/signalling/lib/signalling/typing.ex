# Who is typing in the lobby's chat (NETWORK.md, "The lobby's chat"): the
# pages (Signalling.Online's processes) that said they are, in the last 5
# seconds. A page says so at most every 3 seconds while its player types
# (online.js); a message it sends, or its WebSocket closing, ends it. The
# pages are told only how many, never who: each its own count, without
# itself (Signalling.Online). The topic "typing" carries the typing pages
# each time they change, not at each page's repeat: a page can change them
# only by typing anew after a message (20 a minute: Signalling.Limits) or
# after 5 quiet seconds.
defmodule Signalling.Typing do
  @moduledoc false
  use GenServer

  @topic "typing"
  # how long a page's "typing" lasts (ms): online.js repeats it sooner
  @lasts 5_000
  # how often the ones past are dropped (ms)
  @sweep 1_000

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  # the pages' topic: {:typing, pages}, the typing pages' processes
  def topic, do: @topic

  # the typing pages now
  def current, do: GenServer.call(__MODULE__, :current)

  # the calling page types (again)
  def typing, do: GenServer.cast(__MODULE__, {:typing, self()})

  # the calling page no longer types (it said its message)
  def done, do: GenServer.cast(__MODULE__, {:done, self()})

  # how many pages type, the page itself not among them
  def count(pages, page), do: Enum.count(pages, &(&1 != page))

  @impl true
  def init(_) do
    Process.send_after(self(), :sweep, @sweep)
    # page => {until (monotonic ms), its monitor}
    {:ok, %{}}
  end

  @impl true
  def handle_call(:current, _from, pages), do: {:reply, Map.keys(pages), pages}

  @impl true
  def handle_cast({:typing, page}, pages) do
    until = now() + @lasts

    case pages do
      %{^page => {_, monitor}} ->
        {:noreply, Map.put(pages, page, {until, monitor})}

      _ ->
        changed(Map.put(pages, page, {until, Process.monitor(page)}))
    end
  end

  def handle_cast({:done, page}, pages), do: drop(pages, [page])

  @impl true
  def handle_info({:DOWN, _, :process, page, _}, pages), do: drop(pages, [page])

  def handle_info(:sweep, pages) do
    Process.send_after(self(), :sweep, @sweep)
    now = now()
    drop(pages, for({page, {until, _}} <- pages, until <= now, do: page))
  end

  defp drop(pages, gone) do
    case Enum.filter(gone, &Map.has_key?(pages, &1)) do
      [] ->
        {:noreply, pages}

      gone ->
        for page <- gone, do: Process.demonitor(elem(pages[page], 1), [:flush])
        changed(Map.drop(pages, gone))
    end
  end

  defp changed(pages) do
    Phoenix.PubSub.local_broadcast(Signalling.PubSub, @topic, {:typing, Map.keys(pages)})
    {:noreply, pages}
  end

  defp now, do: System.monotonic_time(:millisecond)
end
