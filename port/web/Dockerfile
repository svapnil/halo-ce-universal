# The machine on Fly.io (fly.toml: `fly deploy` in this folder): the relay
# of native games (relay/main.go) and, beside it, the signalling of games
# between browsers (signalling/), as fly_start.sh starts them
# (NETWORK.md, "The machine"). The tests on one machine take the relay alone
# (relay/test/native_host.sh: --target relay).
FROM golang:1.24-alpine AS relay-build
WORKDIR /src
COPY relay/go.mod relay/go.sum ./
RUN go mod download
COPY relay/main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /relay .

FROM scratch AS relay
COPY --from=relay-build /relay /relay
USER 65534
ENTRYPOINT ["/relay"]

FROM elixir:1.19.4-otp-28-alpine AS signalling-build
WORKDIR /src
ENV MIX_ENV=prod
RUN mix local.hex --force && mix local.rebar --force
COPY signalling/mix.exs signalling/mix.lock ./
RUN mix deps.get --only prod && mix deps.compile
COPY signalling/config config
COPY signalling/lib lib
COPY signalling/rel rel
RUN mix release --path /signalling

# (the release brings its own Erlang: the image it was built in has the
# libraries that one needs, and the certificates for the SFU's HTTPS)
FROM elixir:1.19.4-otp-28-alpine
COPY --from=relay-build /relay /relay
COPY --from=signalling-build /signalling /signalling
COPY fly_start.sh /fly_start.sh
USER 65534
ENTRYPOINT ["/fly_start.sh"]
