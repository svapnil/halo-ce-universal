# One page's WebSocket for the lobby (/net/online?visitor=<id>): kept open
# for as long as the page is, it counts the page's browser among those
# online (Signalling.Presence), tells the page the count, and carries the
# lobby's chat (Signalling.Chat):
#
#   server to page   {"type": "online", "count": n}   when it connects, and
#                                                     as the count changes
#                    {"type": "history", "messages": [...]}   when it connects
#                    {"type": "chat", "id", "name", "color", "text", "at"}
#                    {"type": "typing", "count": n}   when it connects, and
#                                                     as it changes: how many
#                                                     other pages type
#                    {"type": "error", "code": "busy", "message"}  too many
#                                                     messages: not sent
#   page to server   {"type": "name", "name": "..."}  its player's name
#                    {"type": "chat", "text": "..."}
#                    {"type": "typing"}               its player types (at
#                                                     most every 3 seconds)
#                    ping (every 30 seconds)          answered pong
defmodule Signalling.Online do
  @moduledoc false
  @behaviour WebSock

  alias Signalling.{Chat, Limits, OnlineCount, Presence, Typing}

  @impl true
  def init(page) do
    case Limits.enter(page.address, :online) do
      :ok ->
        {:ok, _} = Presence.track(self(), Presence.topic(), page.visitor, %{})
        :ok = Phoenix.PubSub.subscribe(Signalling.PubSub, OnlineCount.topic())
        :ok = Phoenix.PubSub.subscribe(Signalling.PubSub, Chat.topic())
        :ok = Phoenix.PubSub.subscribe(Signalling.PubSub, Typing.topic())
        typing = Typing.count(Typing.current(), self())

        page =
          Map.merge(page, %{name: Chat.name(nil), color: Chat.color(page.visitor), typing: typing})

        history = %{type: "history", messages: Chat.history()}
        {:push, [count(OnlineCount.current()), text(history), typing(typing)], page}

      :busy ->
        # (the page shows no count, and tries again later)
        {:stop, :normal, {1008, "busy"}, page}
    end
  end

  @impl true
  def handle_in({"ping", [opcode: :text]}, page), do: {:push, {:text, "pong"}, page}

  def handle_in({data, [opcode: :text]}, page) do
    case JSON.decode(data) do
      {:ok, %{"type" => "name", "name" => name}} ->
        {:ok, %{page | name: Chat.name(name)}}

      {:ok, %{"type" => "chat", "text" => said}} ->
        say(Chat.text(said), page)

      {:ok, %{"type" => "typing"}} ->
        Typing.typing()
        {:ok, page}

      _ ->
        {:ok, page}
    end
  end

  def handle_in(_, page), do: {:ok, page}

  @impl true
  def handle_info({:online, n}, page), do: {:push, count(n), page}

  def handle_info({:chat, message}, page),
    do: {:push, text(Map.put(message, :type, "chat")), page}

  # (told only when its own count changes: its own typing is not in it)
  def handle_info({:typing, pages}, page) do
    case Typing.count(pages, self()) do
      n when n == page.typing -> {:ok, page}
      n -> {:push, typing(n), %{page | typing: n}}
    end
  end

  def handle_info(_, page), do: {:ok, page}

  @impl true
  def terminate(_, _), do: :ok

  defp say(nil, page), do: {:ok, page}

  defp say(said, page) do
    if Limits.allow?(:chat, page.address) do
      Chat.say(page.name, page.color, said)
      Typing.done()
      {:ok, page}
    else
      busy = %{type: "error", code: "busy", message: "Too many messages: wait a minute"}
      {:push, text(busy), page}
    end
  end

  defp count(n), do: text(%{type: "online", count: n})
  defp typing(n), do: text(%{type: "typing", count: n})
  defp text(message), do: {:text, JSON.encode!(message)}
end
