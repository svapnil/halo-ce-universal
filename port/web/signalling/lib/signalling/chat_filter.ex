# The lobby's chat's blocked words (chat_blocked.txt; NETWORK.md, "The
# lobby's chat"): blocked?/1 for a message's text or a page's name. Simple
# on purpose: a word list, not a moderator, for the slurs said most.
defmodule Signalling.ChatFilter do
  @moduledoc false

  @list Path.join(__DIR__, "chat_blocked.txt")
  @external_resource @list

  {anywhere, words} =
    @list
    |> File.read!()
    |> String.split("\n", trim: true)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == "" or String.starts_with?(&1, "#")))
    |> Enum.split_with(&(not String.starts_with?(&1, "=")))

  # each letter once or more: "nigger" is "n+i+g+g+e+r+", so that "niiigger"
  # is, and "niger" is not
  repeated = fn word -> word |> String.graphemes() |> Enum.map_join(&(&1 <> "+")) end

  # (sources: a compiled regex cannot be a module attribute)
  @anywhere Enum.map_join(anywhere, "|", repeated)
  @words "\\b(?:" <>
           Enum.map_join(words, "|", &repeated.(String.trim_leading(&1, "="))) <> ")s*\\b"

  @look_alikes %{
    "0" => "o",
    "1" => "i",
    "3" => "e",
    "4" => "a",
    "@" => "a",
    "5" => "s",
    "$" => "s",
    "7" => "t",
    "8" => "b",
    "9" => "g",
    "а" => "a",
    "е" => "e",
    "о" => "o",
    "р" => "p",
    "с" => "c",
    "у" => "y",
    "х" => "x",
    "і" => "i",
    "к" => "k",
    "н" => "h",
    "т" => "t",
    "г" => "r"
  }

  def blocked?(text) when is_binary(text) do
    {anywhere, words} = regexes()
    spaced = letters(text)
    Regex.match?(words, spaced) or Regex.match?(anywhere, String.replace(spaced, " ", ""))
  end

  def blocked?(_), do: false

  # the text's letters, a-z, lower case, words between single spaces
  defp letters(text) do
    text
    |> String.downcase()
    |> :unicode.characters_to_nfkd_binary()
    |> String.replace(~r/\p{Mn}/u, "")
    # "n!gger", but "fag!" a word
    |> String.replace(~r/(?<=\pL)[!|](?=\pL)/u, "i")
    |> String.replace(~r/[^a-z\s]/u, &Map.get(@look_alikes, &1, " "))
    |> String.replace(~r/[^a-z]+/, " ")
  end

  defp regexes do
    case :persistent_term.get(__MODULE__, nil) do
      nil ->
        regexes = {Regex.compile!(@anywhere), Regex.compile!(@words)}
        :persistent_term.put(__MODULE__, regexes)
        regexes

      regexes ->
        regexes
    end
  end
end
