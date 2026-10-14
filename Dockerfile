# Build stage
FROM golang:1.27.2-alpine3.24 AS build

WORKDIR /app

# Copy only what Go needs to build, leave out go.sum as it's not used
COPY go.mod ./
RUN go mod download

COPY main.go .
COPY web/ ./web/

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o gameshelf main.go

# Runtime stage
FROM alpine:3.24.2
WORKDIR /app

COPY --from=build /app/gameshelf .

# Default internal port, can be overridden with -p flag or environment variable
EXPOSE 8080

ENTRYPOINT ["/app/gameshelf"]
