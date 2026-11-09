# Universal SRT ingest (any container / any codec FFmpeg can read) → MediaMTX.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /srt-gateway .

FROM mwader/static-ffmpeg:9.0.2-1 AS ffmpeg

FROM alpine:3.22
RUN apk add --no-cache tini ca-certificates
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=build /srt-gateway /usr/local/bin/srt-gateway
USER nobody
EXPOSE 8891/udp 9101
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["srt-gateway", "-healthcheck"]
ENTRYPOINT ["/sbin/tini", "--", "srt-gateway"]
