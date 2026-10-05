defmodule Signalling.MixProject do
  use Mix.Project

  def project do
    [
      app: :signalling,
      version: "0.1.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      releases: [signalling: [include_executables_for: [:unix]]]
    ]
  end

  def application do
    [extra_applications: [:logger], mod: {Signalling.Application, []}]
  end

  defp deps do
    [
      {:bandit, "~> 1.6"},
      {:websock_adapter, "~> 0.5"},
      {:req, "~> 0.5"}
    ]
  end
end
