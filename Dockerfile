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

EXPOSE 8080

ENTRYPOINT ["/app/gameshelf"]
