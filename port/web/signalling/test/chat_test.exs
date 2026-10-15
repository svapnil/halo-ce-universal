# mix test --no-start
defmodule Signalling.ChatTest do
  use ExUnit.Case, async: true
  alias Signalling.Chat

  # a letter under n combining marks, as a Zalgo generator makes them
  defp zalgo(letter, n), do: letter <> String.duplicate("\u0338\u0300\u031A\u0313", div(n, 4))

  # (NFC puts a letter's marks in their canonical order, so which 2 are kept
  # is the order's, and a letter and a mark may be one letter: "ẁ")
  defp decomposed(text), do: :unicode.characters_to_nfd_binary(text)
  defp letters(text), do: String.replace(decomposed(text), ~r/\p{M}/u, "")
  defp marks(text), do: length(Regex.scan(~r/\p{M}/u, decomposed(text)))

  test "keeps at most 2 combining marks on a letter" do
    text = Chat.text(zalgo("s", 48) <> zalgo("t", 48) <> "fu")
    assert letters(text) == "stfu"
    assert marks(text) == 4

    name = Chat.name(zalgo("New", 40))
    assert letters(name) == "New"
    assert marks(name) == 2
  end

  test "lets accents through, however they are typed" do
    assert Chat.text("Vai corinthiaaans, ação!") == "Vai corinthiaaans, ação!"
    # decomposed: a and its tilde, e and its acute
    assert Chat.text("ac\u0327a\u0303o cafe\u0301") == "ação café"
    assert Chat.text("Tiếng Việt") == "Tiếng Việt"
  end

  test "still makes control characters spaces" do
    assert Chat.text("a\u0000b\u200Bc") == "a b c"
  end
end

defmodule Signalling.ChatGhostTest do
  use ExUnit.Case, async: false
  alias Signalling.Chat

  setup do
    # (--no-start: PubSub's application too)
    {:ok, _} = Application.ensure_all_started(:phoenix_pubsub)
    start_supervised!({Phoenix.PubSub, name: Signalling.PubSub})
    start_supervised!(Chat)
    :ok = Phoenix.PubSub.subscribe(Signalling.PubSub, Chat.topic())
    :ok
  end

  # a page's run after these messages
  defp run(texts), do: Enum.reduce(texts, nil, &Chat.repeated(&2, &1))

  test "the same message 4 times in a row is spam" do
    refute Chat.spam?(run(["stfu", "stfu", "stfu"]))
    assert Chat.spam?(run(["stfu", "stfu", "stfu", "stfu"]))
    assert Chat.spam?(run(["stfu", "stfu", "stfu", "stfu", "stfu"]))
    # (another message between them starts the run again)
    refute Chat.spam?(run(["stfu", "stfu", "hi", "stfu", "stfu"]))
    refute Chat.spam?(run(["gg", "GG", "gg", "gg"]))
  end

  test "a ghost's messages are its own: not the history's" do
    refute Chat.ghosted?("spammer0123456789")
    :ok = Chat.ghost("spammer0123456789", "New001")
    assert Chat.ghosted?("spammer0123456789")
    refute Chat.ghosted?("someone0123456789")

    # (told once: to its own page, this, and not to the topic)
    Chat.say("New001", "cyan", "stfu", true)
    assert_receive {:chat, %{text: "stfu"}}
    refute_receive {:chat, _}, 100
    assert Chat.history() == []

    Chat.say("scrappy117", "pink", "hey yall")
    assert_receive {:chat, %{text: "hey yall"}}
    assert [%{text: "hey yall"}] = Chat.history()
  end
end
