# Build stage
FROM golang:1.22-alpine AS build

WORKDIR /app

# Copy module file
COPY go.mod ./
RUN go mod download

# Copy entire source (including web/)
COPY . .

# Build binary (embedding happens here)
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o gameshelf main.go

# Runtime stage
FROM alpine:3.20

WORKDIR /app

# Copy binary only
COPY --from=build /app/gameshelf /app/gameshelf

EXPOSE 8080

ENTRYPOINT ["/app/gameshelf"]