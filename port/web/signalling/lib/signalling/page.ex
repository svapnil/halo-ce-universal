# One page's WebSocket: NETWORK.md's messages ("Signalling messages"), and
# the page's own SFU session. Its stages: :new, :welcomed (the room took it),
# :offered (it has the SFU's offer), :ready (it answered), and for a joiner
# :linked.
defmodule Signalling.Page do
  @moduledoc false
  @behaviour WebSock

  alias Signalling.{Limits, Room, SFU}

  @protocol_version 1
  @host_peer 0
  # the link's two channels (NETWORK.md, "Data channels")
  @channels [
    {"reliable", %{ordered: true}},
    {"unreliable", %{ordered: false, maxRetransmits: 0}}
  ]

  # refuses a page's WebSocket with a reason it can show (an HTTP error would
  # reach it only as a WebSocket that failed)
  @impl true
  def init(%{refused: message} = page) when is_binary(message), do: refuse(page, message)

  def init(page) do
    case Limits.enter(page.address) do
      :ok ->
        page =
          Map.merge(page, %{
            stage: :new,
            peer: nil,
            room: nil,
            host: nil,
            session: nil,
            timer: nil
          })

        {:ok, expect_answer(page)}

      :busy ->
        refuse(page, "Too many pages from this address")
    end
  end

  defp refuse(page, message) do
    {:stop, :normal, {1008, "busy"}, [error("busy", message)], page}
  end

  @impl true
  # answered without a word to the room (NETWORK.md, "Signalling messages")
  def handle_in({"ping", [opcode: :text]}, page), do: {:push, {:text, "pong"}, page}

  def handle_in({text, [opcode: :text]}, page) do
    case JSON.decode(text) do
      {:ok, %{"type" => type} = data} when is_binary(type) ->
        message(type, data, page) |> result(page)

      _ ->
        fail(page, "protocol", "Expected a JSON object with a type")
    end
  end

  def handle_in(_, page), do: fail(page, "protocol", "Expected a JSON object with a type")

  @impl true
  def handle_info({:push, message}, page), do: {:push, text(message), page}
  def handle_info({:fail, code, message}, page), do: fail(page, code, message)
  def handle_info(:offer, %{stage: :welcomed} = page), do: offer(page) |> result(page)

  # a page that has not answered the SFU's offer by then is closed
  def handle_info({:no_answer, timer}, %{timer: timer} = page) do
    fail(page, "timeout", "No answer to the offer")
  end

  def handle_info(_, page), do: {:ok, page}

  @impl true
  def terminate(_, _), do: :ok

  # ---------- the messages: {:ok, what to send, the page} or {:error, code, why}

  defp message("host", data, %{stage: :new, role: :host} = page) do
    with :ok <- check_hello(data),
         {:ok, room, secret} <- Room.open(page.code, data["id"], data["netVersion"]) do
      send(self(), :offer)
      welcome = %{type: "welcome", room: page.code, peer: @host_peer, secret: secret}
      {:ok, [welcome], %{page | stage: :welcomed, peer: @host_peer, room: room}}
    end
  end

  defp message("join", data, %{stage: :new, role: :join} = page) do
    with :ok <- check_hello(data),
         {:ok, joined} <- Room.join(page.code, data["id"], data["netVersion"], data["secret"]) do
      send(self(), :offer)
      welcome = %{type: "welcome", room: page.code, peer: joined.peer}

      {:ok, [welcome],
       %{page | stage: :welcomed, peer: joined.peer, room: joined.room, host: joined.host}}
    end
  end

  defp message("answer", %{"sdp" => sdp}, %{stage: :offered} = page) when is_binary(sdp) do
    description = %{sessionDescription: %{type: "answer", sdp: sdp}}

    with {:ok, _} <- SFU.request(:put, "/sessions/#{page.session}/renegotiate", description) do
      page = %{page | stage: :ready, timer: nil}

      if page.role == :host do
        Room.host_ready(page.room)
        {:ok, [], page}
      else
        link(page)
      end
    end
  end

  defp message("answer", _, %{stage: :offered}),
    do: {:error, "protocol", "An answer needs its sdp"}

  defp message("drop", data, %{stage: :ready, role: :host} = page) do
    Room.drop(page.room, data["peer"])
    {:ok, [], page}
  end

  defp message(type, _, _), do: {:error, "protocol", "Unexpected #{type}"}

  defp check_hello(data) do
    cond do
      data["version"] != @protocol_version ->
        {:error, "version", "This server speaks version #{@protocol_version} of the protocol"}

      not (identifier?(data["id"]) and net_version?(data["netVersion"])) ->
        {:error, "protocol", "Expected an id (12 hex digits) and a netVersion"}

      true ->
        :ok
    end
  end

  defp identifier?(value), do: is_binary(value) and value =~ ~r/^[0-9a-f]{12}$/
  defp net_version?(value), do: is_integer(value) and value in 0..0xFFFF

  # makes the page's SFU session and sends it the SFU's offer
  defp offer(page) do
    page = expect_answer(page)
    events = %{dataChannel: %{location: "remote", dataChannelName: "server-events"}}

    with {:ok, %{"sessionId" => session}} when is_binary(session) <-
           SFU.request(:post, "/sessions/new"),
         {:ok, %{"sessionDescription" => %{"type" => "offer", "sdp" => sdp}}} <-
           SFU.request(:post, "/sessions/#{session}/datachannels/establish", events) do
      if page.role == :host, do: Room.host_session(page.room, session)
      {:ok, [%{type: "offer", sdp: sdp}], %{page | stage: :offered, session: session}}
    else
      {:error, _, _} = error -> error
      _ -> {:error, "sfu", "The SFU did not offer a connection"}
    end
  end

  # a joiner publishes the link's channels and the host subscribes to them,
  # able to reply (NETWORK.md, "Data channels")
  defp link(page) do
    host = page.host

    local =
      for {name, options} <- @channels,
          do: Map.merge(%{location: "local", dataChannelName: name}, options)

    remote =
      for {name, options} <- @channels do
        %{location: "remote", sessionId: page.session, dataChannelName: name, canReply: true}
        |> Map.merge(options)
        |> Map.merge(if name == "reliable", do: %{waitForAck: true}, else: %{})
      end

    with {:ok, published} <-
           SFU.request(:post, "/sessions/#{page.session}/datachannels/new", %{dataChannels: local}),
         {:ok, subscribed} <-
           SFU.request(:post, "/sessions/#{host.session}/datachannels/new", %{
             dataChannels: remote
           }),
         {:ok, mine} <- channel_ids(published),
         {:ok, hosts} <- channel_ids(subscribed),
         :ok <- Room.linked(page.room, hosts) do
      link = %{type: "link", peer: @host_peer, id: host.id, netVersion: host.net_version}
      {:ok, [Map.merge(link, mine)], %{page | stage: :linked}}
    end
  end

  # the SFU's ids of the two channels, by name
  defp channel_ids(result) do
    channels = if is_list(result["dataChannels"]), do: result["dataChannels"], else: []

    @channels
    |> Enum.with_index()
    |> Enum.reduce_while({:ok, %{}}, fn {{name, _}, index}, {:ok, ids} ->
      case Enum.find(channels, &(is_map(&1) and &1["dataChannelName"] == name)) ||
             Enum.at(channels, index) do
        %{"id" => id} = channel when is_integer(id) and not is_map_key(channel, "errorCode") ->
          {:cont, {:ok, Map.put(ids, name, id)}}

        _ ->
          {:halt, {:error, "sfu", "The SFU did not make the #{name} channel"}}
      end
    end)
  end

  # ---------- what goes back

  defp result({:ok, messages, page}, _), do: {:push, Enum.map(messages, &text/1), page}
  defp result({:error, code, message}, page), do: fail(page, code, message)

  # tells the page why, and lets it go
  defp fail(page, code, message) do
    reason = if code == "dropped", do: "dropped", else: "failed"
    if page.role == :join and page.room, do: Room.gone(page.room, reason)
    {:stop, :normal, {1000, reason}, [error(code, message)], page}
  end

  defp error(code, message), do: text(%{type: "error", code: code, message: message})
  defp text(message), do: {:text, JSON.encode!(message)}

  defp expect_answer(page) do
    timer = make_ref()

    Process.send_after(
      self(),
      {:no_answer, timer},
      Application.fetch_env!(:signalling, :answer_timeout)
    )

    %{page | timer: timer}
  end
end
