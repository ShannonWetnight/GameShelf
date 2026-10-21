# Build stage
FROM golang:1.27.2-alpine3.24 AS build
RUN apk upgrade --no-cache
# The 1.27.3 official image is pending; install the patched Go release with
# the SHA256 published at https://go.dev/dl/ for the amd64 build target.
RUN wget -q -O /tmp/go.tar.gz https://go.dev/dl/go1.27.3.linux-amd64.tar.gz \
    && echo '65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40  /tmp/go.tar.gz' | sha256sum -c - \
    && rm -rf /usr/local/go \
    && tar -C /usr/local -xzf /tmp/go.tar.gz \
    && rm /tmp/go.tar.gz \
    && go version

WORKDIR /app

# Copy only what Go needs to build, leave out go.sum as it's not used
COPY go.mod ./
RUN go mod download

COPY main.go .
COPY web/ ./web/

ARG GAMESHELF_BUILD_VERSION=Development
ARG GAMESHELF_BUILD_CHANNEL=development
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags "-X main.buildVersion=${GAMESHELF_BUILD_VERSION} -X main.buildChannel=${GAMESHELF_BUILD_CHANNEL}" \
    -o gameshelf main.go

# Runtime stage
FROM alpine:3.24.2
# Apply security fixes published since the base image was built.
RUN apk upgrade --no-cache
WORKDIR /app

COPY --from=build /app/gameshelf .
RUN addgroup -S -g 10001 gameshelf \
    && adduser -S -D -H -u 10001 -G gameshelf -s /sbin/nologin gameshelf \
    && mkdir -p /data && chown 10001:10001 /data \
    && chmod 0555 /app /app/gameshelf

# Numeric IDs make bind-mount permissions predictable and allow runtime overrides.
# Keep the executable root-owned; the application only needs read access to games.
USER 10001:10001

# Docker creates writable state storage when no explicit /data mount is supplied.
VOLUME ["/data"]

# Default internal port, can be overridden with -p flag or environment variable
EXPOSE 8080

ENTRYPOINT ["/app/gameshelf"]
