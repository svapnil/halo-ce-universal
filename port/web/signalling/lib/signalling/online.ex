# One page's WebSocket for the lobby (/net/online?visitor=<id>): kept open
# for as long as the page is, it counts the page's browser among those
# online (Signalling.Presence), tells the page the count, and carries the
# lobby's chat (Signalling.Chat):
#
#   server to page   {"type": "online", "count": n}   when it connects, and
#                                                     as the count changes
#                    {"type": "history", "messages": [...]}   when it connects
#                    {"type": "chat", "id", "name", "color", "text", "at"}
#                    {"type": "error", "code": "busy", "message"}  too many
#                                                     messages: not sent
#   page to server   {"type": "name", "name": "..."}  its player's name
#                    {"type": "chat", "text": "..."}
#                    ping (every 30 seconds)          answered pong
defmodule Signalling.Online do
  @moduledoc false
  @behaviour WebSock

  alias Signalling.{Chat, Limits, OnlineCount, Presence}

  @impl true
  def init(page) do
    case Limits.enter(page.address, :online) do
      :ok ->
        {:ok, _} = Presence.track(self(), Presence.topic(), page.visitor, %{})
        :ok = Phoenix.PubSub.subscribe(Signalling.PubSub, OnlineCount.topic())
        :ok = Phoenix.PubSub.subscribe(Signalling.PubSub, Chat.topic())
        page = Map.merge(page, %{name: Chat.name(nil), color: Chat.color(page.visitor)})
        history = %{type: "history", messages: Chat.history()}
        {:push, [count(OnlineCount.current()), text(history)], page}

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

      _ ->
        {:ok, page}
    end
  end

  def handle_in(_, page), do: {:ok, page}

  @impl true
  def handle_info({:online, n}, page), do: {:push, count(n), page}

  def handle_info({:chat, message}, page),
    do: {:push, text(Map.put(message, :type, "chat")), page}

  def handle_info(_, page), do: {:ok, page}

  @impl true
  def terminate(_, _), do: :ok

  defp say(nil, page), do: {:ok, page}

  defp say(said, page) do
    if Limits.allow?(:chat, page.address) do
      Chat.say(page.name, page.color, said)
      {:ok, page}
    else
      busy = %{type: "error", code: "busy", message: "Too many messages: wait a minute"}
      {:push, text(busy), page}
    end
  end

  defp count(n), do: text(%{type: "online", count: n})
  defp text(message), do: {:text, JSON.encode!(message)}
end
