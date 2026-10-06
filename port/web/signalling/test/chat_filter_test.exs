# mix test --no-start
defmodule Signalling.ChatFilterTest do
  use ExUnit.Case, async: true
  import Signalling.ChatFilter, only: [blocked?: 1]

  test "blocks the words, however they are spelt" do
    for text <- [
          "nigger",
          "NIIIGGER lol",
          "n.i g g-e r",
          "n1gg3r",
          "n!gger",
          "nígger",
          "you faggots",
          "f4g",
          "fag!",
          "spics",
          "go home kike",
          "ch1nk",
          "sieg heil",
          "nіgger"
        ] do
      assert blocked?(text), text
    end
  end

  test "lets the words they are in through" do
    for text <- [
          "gg",
          "Niger",
          "Nigeria is far",
          "raccoon",
          "cocoon",
          "spicy",
          "kiked off",
          "Scunthorpe",
          "fagioli",
          "chinking glasses",
          "snigglet",
          "googly",
          "good game, that was a nice kill",
          "spice",
          "tycoon",
          "",
          "1v1 me"
        ] do
      refute blocked?(text), text
    end
  end
end
