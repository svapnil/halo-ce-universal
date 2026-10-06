# The lobby's chat (NETWORK.md, "The lobby's chat"): what the pages say,
# to every page with the site open (Signalling.Online's WebSockets, the
# topic "chat"), and the last 50 for a page that comes. In memory: a
# restart forgets them.
defmodule Signalling.Chat do
  @moduledoc false
  use GenServer

  @topic "chat"
  @kept 50
  @longest_name 11
  @longest_text 200
  @default_name "New001"

  # the player colours of a multiplayer game, in the game's order: a
  # visitor's is one of them, by its id, the same at every visit
  @colors ~w(white black red blue gray yellow green pink purple cyan cobalt
             orange teal sage brown tan maroon salmon)

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  # the pages' topic: {:chat, message}
  def topic, do: @topic

  # the last messages, oldest first
  def history, do: GenServer.call(__MODULE__, :history)

  # a page says text (already its own: name/1, text/1, color/1)
  def say(name, color, text), do: GenServer.cast(__MODULE__, {:say, name, color, text})

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

  @impl true
  def init(_), do: {:ok, %{next: 1, messages: :queue.new(), count: 0}}

  @impl true
  def handle_call(:history, _from, state), do: {:reply, :queue.to_list(state.messages), state}

  @impl true
  def handle_cast({:say, name, color, text}, state) do
    message = %{id: state.next, name: name, color: color, text: text, at: System.os_time(:second)}
    Phoenix.PubSub.local_broadcast(Signalling.PubSub, @topic, {:chat, message})
    messages = :queue.in(message, state.messages)

    {messages, count} =
      if state.count >= @kept,
        do: {:queue.drop(messages), state.count},
        else: {messages, state.count + 1}

    {:noreply, %{state | next: state.next + 1, messages: messages, count: count}}
  end
end
