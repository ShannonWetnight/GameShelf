# Build stage
FROM golang:1.27.2-alpine3.24 AS build
RUN apk upgrade --no-cache

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
    && chmod 0555 /app /app/gameshelf

# Numeric IDs make bind-mount permissions predictable and allow runtime overrides.
# Keep the executable root-owned; the application only needs read access to games.
USER 10001:10001

# Default internal port, can be overridden with -p flag or environment variable
EXPOSE 8080

ENTRYPOINT ["/app/gameshelf"]
