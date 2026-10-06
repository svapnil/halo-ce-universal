# The signalling of network play between browsers (port/web/NETWORK.md): the
# rooms that worker/rooms.js keeps as Durable Objects, here a process each.
# Pages talk to it over a WebSocket, in NETWORK.md's JSON messages, and it
# sets up their links through Cloudflare Realtime SFU. Game traffic never
# comes here. It runs on the relay's machine (port/web/fly.toml), at the
# lowest priority (NETWORK.md, "The machine").
#
#   mix run --no-halt       (the settings: config/runtime.exs)
#   node --test signalling/test/rooms.test.mjs      in port/web
#
#   Signalling.Router   the WebSocket's address, /net/rooms/<room>
#   Signalling.Page     one page's WebSocket
#   Signalling.Room     one hosted game
#   Signalling.SFU      the calls to the SFU
#   Signalling.Limits   what an address may do
#   Signalling.Online   one page's WebSocket for the lobby (the online count
#                       and the chat), /net/online
#   Signalling.Presence who is online (Phoenix's Presence)
#   Signalling.OnlineCount  the count, as the pages get it
#   Signalling.Chat     the lobby's chat
defmodule Signalling.Application do
  @moduledoc false
  use Application
  require Logger

  # at most 800 pages at once (each acceptor takes 200): the machine's memory
  # is the relay's too
  @acceptors 4
  @pages_per_acceptor 200

  @impl true
  def start(_type, _arguments) do
    host = Application.fetch_env!(:signalling, :host)
    port = Application.fetch_env!(:signalling, :port)
    {:ok, address} = host |> String.to_charlist() |> :inet.parse_address()

    children = [
      {Registry, keys: :unique, name: Signalling.Rooms},
      {DynamicSupervisor, name: Signalling.RoomSupervisor, strategy: :one_for_one},
      {Task.Supervisor, name: Signalling.Tasks},
      Signalling.Limits,
      {Phoenix.PubSub, name: Signalling.PubSub},
      Signalling.Presence,
      Signalling.OnlineCount,
      Signalling.Chat,
      {Bandit,
       plug: Signalling.Router,
       scheme: :http,
       ip: address,
       port: port,
       startup_log: false,
       thousand_island_options: [num_acceptors: @acceptors, num_connections: @pages_per_acceptor]}
    ]

    with {:ok, supervisor} <-
           Supervisor.start_link(children, strategy: :one_for_one, name: Signalling.Supervisor) do
      Logger.info("signalling: listening on #{host}:#{port}")
      {:ok, supervisor}
    end
  end
end
