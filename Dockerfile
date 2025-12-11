# Build stage
FROM golang:1.22-alpine AS build

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o gameshelf main.go

# Runtime stage
FROM alpine:3.20

WORKDIR /app

# Copy binary
COPY --from=build /app/gameshelf /app/gameshelf

# Copy static frontend assets
COPY index.html /app/index.html
COPY styles.css /app/styles.css
COPY app.js /app/app.js
COPY placeholder.png /app/placeholder.png

# Environment
ENV GAMESHELF_ROOT=/games
ENV GAMESHELF_ADDR=:8080
ENV GAMESHELF_REFRESH_INTERVAL=5m

EXPOSE 8080

ENTRYPOINT ["/app/gameshelf"]
