# The online count, as the pages get it: Presence tells it of each change,
# and it tells the pages (the topic "online:count") at most once every 2
# seconds, and only when the number has changed. A change for each page
# would be a message to every page for each that comes or goes; so many
# pages come back at once after a restart. Idle, it does nothing (no timer).
defmodule Signalling.OnlineCount do
  @moduledoc false
  use GenServer

  @topic "online:count"
  @every 2_000

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  # the pages' topic: {:online, count}
  def topic, do: @topic

  # the count now (a page that has just come: it gets the next by the topic)
  def current, do: GenServer.call(__MODULE__, :current)

  # from Signalling.Presence
  def changed(count), do: send(__MODULE__, {:changed, count})

  @impl true
  def init(_), do: {:ok, %{count: 0, told: 0, timer: nil}}

  @impl true
  def handle_call(:current, _from, state), do: {:reply, state.count, state}

  @impl true
  def handle_info({:changed, count}, %{timer: nil} = state) do
    {:noreply, %{state | count: count, timer: Process.send_after(self(), :tell, @every)}}
  end

  def handle_info({:changed, count}, state), do: {:noreply, %{state | count: count}}

  def handle_info(:tell, state) do
    if state.count != state.told do
      Phoenix.PubSub.local_broadcast(Signalling.PubSub, @topic, {:online, state.count})
    end

    {:noreply, %{state | told: state.count, timer: nil}}
  end
end
