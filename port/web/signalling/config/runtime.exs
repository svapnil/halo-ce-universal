import Config

# The settings (the environment): port/web/NETWORK.md, "The signalling's server"
list = fn text -> text |> String.split(",", trim: true) |> Enum.map(&String.trim/1) end

config :signalling,
  host: System.get_env("SIGNALLING_HOST", "127.0.0.1"),
  port: String.to_integer(System.get_env("SIGNALLING_PORT", "8791")),
  origins: list.(System.get_env("SIGNALLING_ORIGINS", "")),
  answer_timeout: String.to_integer(System.get_env("SIGNALLING_ANSWER_TIMEOUT", "30000")),
  pages_at_once: String.to_integer(System.get_env("SIGNALLING_PAGES_AT_ONCE", "32")),
  sfu: [
    api: System.get_env("SFU_API", "https://rtc.live.cloudflare.com/v1"),
    app_id: System.get_env("REALTIME_APP_ID", ""),
    token: System.get_env("REALTIME_APP_TOKEN", "")
  ]
