# Build stage
FROM golang:1.22-alpine AS build

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

# Copy source including web folder for embedding
COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o gameshelf main.go

# Runtime stage
FROM alpine:3.20

WORKDIR /app

# Copy binary
COPY --from=build /app/gameshelf /app/gameshelf

# Copy static assets into container
COPY web/ /app/web/

# Disable auto-refresh by default
ENV GAMESHELF_REFRESH_INTERVAL=0

EXPOSE 8080

ENTRYPOINT ["/app/gameshelf"]