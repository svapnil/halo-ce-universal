# The calls to Cloudflare Realtime SFU, with the app's token, which only
# this server holds (REALTIME_APP_ID, REALTIME_APP_TOKEN): the same JSON as
# worker/rooms.js's sfuRequest.
defmodule Signalling.SFU do
  @moduledoc false
  require Logger

  @timeout 10_000

  # {:ok, the answer} or {:error, "sfu", why}
  def request(method, path, body \\ nil) do
    settings = Application.fetch_env!(:signalling, :sfu)

    if settings[:app_id] == "" or settings[:token] == "" do
      {:error, "sfu", "The server has no Realtime SFU app (REALTIME_APP_ID, REALTIME_APP_TOKEN)"}
    else
      options = [
        method: method,
        url: "#{settings[:api]}/apps/#{URI.encode_www_form(settings[:app_id])}#{path}",
        auth: {:bearer, settings[:token]},
        headers: [{"content-type", "application/json"}],
        receive_timeout: @timeout,
        connect_options: [timeout: @timeout],
        retry: false,
        decode_body: false
      ]

      options = if body, do: [{:body, JSON.encode!(body)} | options], else: options
      name = "#{method |> to_string() |> String.upcase()} #{path}"

      case Req.request(options) do
        {:ok, %Req.Response{status: status, body: text}} ->
          case JSON.decode(text) do
            {:ok, %{"errorCode" => code} = payload} when code not in [nil, false, ""] ->
              Logger.error("SFU #{name}: #{code} #{payload["errorDescription"]}")
              {:error, "sfu", "The SFU refused the request"}

            {:ok, %{} = payload} when status in 200..299 ->
              {:ok, payload}

            _ ->
              Logger.error("SFU #{name}: #{status}")
              {:error, "sfu", "The SFU refused the request"}
          end

        {:error, _} ->
          {:error, "sfu", "The SFU did not answer #{path}"}
      end
    end
  end
end
