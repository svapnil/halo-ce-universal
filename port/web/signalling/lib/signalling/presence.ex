# Who is on the site (NETWORK.md, "The online count"): each page's
# Signalling.Online tracks itself on the topic "online", by its browser's
# visitor id, so that a browser's tabs are one. Phoenix's Presence, without
# its Endpoint or Channels; on one machine, so its replication between nodes
# is unused.
defmodule Signalling.Presence do
  @moduledoc false
  use Phoenix.Presence, otp_app: :signalling, pubsub_server: Signalling.PubSub

  @topic "online"

  def topic, do: @topic

  @impl true
  def init(_), do: {:ok, nil}

  # the topic's presences, after each change: one key a browser
  @impl true
  def handle_metas(@topic, _diff, presences, state) do
    Signalling.OnlineCount.changed(map_size(presences))
    {:ok, state}
  end

  def handle_metas(_topic, _diff, _presences, state), do: {:ok, state}
end
