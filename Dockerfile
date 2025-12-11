# Build stage
FROM golang:1.22-alpine AS build

WORKDIR /app

COPY go.mod ./
RUN go mod tidy

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o gameshelf main.go

# Runtime stage
FROM alpine:3.20

WORKDIR /app

COPY --from=build /app/gameshelf /app/gameshelf

# No need to copy web/ because it's embedded
ENV GAMESHELF_ROOT=/games
ENV GAMESHELF_ADDR=:8080
ENV GAMESHELF_REFRESH_INTERVAL=5m

EXPOSE 8080

ENTRYPOINT ["/app/gameshelf"]
