# The relay of native games (main.go; port/web/NETWORK.md), for Fly.io
# (fly.toml: `fly deploy` in this folder) and for the tests on one machine
# (test/native_host.sh).
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /relay .

FROM scratch
COPY --from=build /relay /relay
USER 65534
ENTRYPOINT ["/relay"]
