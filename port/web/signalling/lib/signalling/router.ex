# /net/rooms/new (host) and /net/rooms/<room> (join), as the Worker's
# handleRooms (worker/rooms.js); /net/online, the online count and the
# lobby's chat; /healthz; and /stats, the rooms' games (on the machine only).
defmodule Signalling.Router do
  @moduledoc false
  use Plug.Router

  alias Signalling.{Limits, Online, Page, Room}

  # the page pings every 30 seconds (NETWORK.md, "Signalling messages"): one
  # that has sent nothing for this long is gone
  @silence 90_000
  # an answer's SDP is a few KiB
  @maximum_message 0x10000

  plug(:match)
  plug(:dispatch)

  get "/healthz" do
    send_resp(conn, 200, "ok #{Registry.count(Signalling.Rooms)}\n")
  end

  # every room and its game, as JSON (NETWORK.md, "The room's game"). Only
  # on the machine: the relay passes /net/rooms/ and /net/online on, not this
  get "/stats" do
    rooms = Room.all()

    stats = %{
      at: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601(),
      online: Signalling.OnlineCount.current(),
      rooms: rooms
    }

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, JSON.encode!(stats))
  end

  get "/net/rooms/:name" do
    role = if name == "new", do: :host, else: :join
    code = if role == :host, do: Room.new_code(), else: String.upcase(name)

    cond do
      not upgrade?(conn) ->
        send_resp(conn, 426, "Expected a WebSocket")

      # only the site's own pages may use the SFU through it
      not origin_allowed?(conn) ->
        send_resp(conn, 403, "Forbidden")

      not Room.code?(code) ->
        send_resp(conn, 404, "Not found")

      true ->
        address = address(conn)
        # (each room and join is SFU sessions on the account's bill)
        refused = if Limits.allow?(role, address), do: nil, else: busy(role)
        page = %{role: role, code: code, address: address, refused: refused}

        conn
        |> WebSockAdapter.upgrade(Page, page, timeout: @silence, max_frame_size: @maximum_message)
        |> halt()
    end
  end

  # the page's browser's visitor id (online.js): ?visitor=<id>
  get "/net/online" do
    conn = fetch_query_params(conn)
    visitor = conn.query_params["visitor"]

    cond do
      not upgrade?(conn) ->
        send_resp(conn, 426, "Expected a WebSocket")

      not origin_allowed?(conn) ->
        send_resp(conn, 403, "Forbidden")

      not (is_binary(visitor) and visitor =~ ~r/^[0-9A-Za-z_-]{16,64}$/) ->
        send_resp(conn, 400, "Expected a visitor")

      true ->
        page = %{visitor: visitor, address: address(conn)}

        conn
        |> WebSockAdapter.upgrade(Online, page, timeout: @silence, max_frame_size: 0x1000)
        |> halt()
    end
  end

  match _ do
    send_resp(conn, 404, "Not found")
  end

  defp busy(:host), do: "Too many games from this address: try again in a minute"
  defp busy(:join), do: "Too many joins from this address: try again in a minute"

  defp upgrade?(conn) do
    conn |> get_req_header("upgrade") |> Enum.any?(&(String.downcase(&1) == "websocket"))
  end

  defp origin_allowed?(conn) do
    case Application.fetch_env!(:signalling, :origins) do
      [] -> true
      origins -> Enum.any?(get_req_header(conn, "origin"), &(&1 in origins))
    end
  end

  # (on Fly.io, the page's address is in Fly-Client-IP)
  defp address(conn) do
    case get_req_header(conn, "fly-client-ip") do
      [address | _] -> address
      [] -> conn.remote_ip |> :inet.ntoa() |> to_string()
    end
  end
end
