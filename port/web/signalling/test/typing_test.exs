# mix test --no-start
defmodule Signalling.TypingTest do
  use ExUnit.Case, async: false
  alias Signalling.Typing

  setup do
    # (--no-start: PubSub's application too)
    {:ok, _} = Application.ensure_all_started(:phoenix_pubsub)
    start_supervised!({Phoenix.PubSub, name: Signalling.PubSub})
    start_supervised!(Typing)
    :ok = Phoenix.PubSub.subscribe(Signalling.PubSub, Typing.topic())
    :ok
  end

  # a page: a process that types when told, and says its message
  defp page do
    spawn(fn ->
      receive_loop()
    end)
  end

  defp receive_loop do
    receive do
      :type -> Typing.typing()
      :say -> Typing.done()
    end

    receive_loop()
  end

  test "a page that types is told to the others, once" do
    a = page()
    send(a, :type)
    assert_receive {:typing, [^a]}
    send(a, :type)
    refute_receive {:typing, _}, 200
    assert Typing.count(Typing.current(), a) == 0
    assert Typing.count(Typing.current(), self()) == 1
  end

  test "its message ends it" do
    a = page()
    send(a, :type)
    assert_receive {:typing, [^a]}
    send(a, :say)
    assert_receive {:typing, []}
  end

  test "its page closing ends it" do
    a = page()
    b = page()
    send(a, :type)
    send(b, :type)
    assert_receive {:typing, [_]}
    assert_receive {:typing, [_, _]}
    Process.exit(a, :kill)
    assert_receive {:typing, [^b]}
  end

  test "it lasts 5 seconds" do
    a = page()
    send(a, :type)
    assert_receive {:typing, [^a]}
    refute_receive {:typing, _}, 4_000
    assert_receive {:typing, []}, 2_500
  end
end
