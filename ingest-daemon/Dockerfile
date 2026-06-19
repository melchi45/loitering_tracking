# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM golang:1.22-bookworm AS builder

# libav development headers (needed for CGO H264 decoder — gmf/openh264)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libavcodec-dev libavformat-dev libavutil-dev libswscale-dev \
    pkg-config gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-s -w" -o ingest-daemon .

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libavcodec60 libavformat60 libavutil58 libswscale7 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/ingest-daemon /usr/local/bin/ingest-daemon

EXPOSE 7070

ENTRYPOINT ["ingest-daemon", "--addr", ":7070"]
