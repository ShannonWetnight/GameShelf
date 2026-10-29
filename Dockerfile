# Build only the connector backends and commands GameShelf uses. Keep test
# servers in a separate binary so they are never shipped in the runtime.
FROM golang:1.27.3-alpine3.24 AS connector-build
ARG GAMESHELF_SECURITY_EPOCH=development
RUN apk upgrade --no-cache
WORKDIR /connector
COPY connectors/rclone/go.mod connectors/rclone/go.sum ./
RUN go mod download
COPY connectors/rclone/*.go ./
COPY connectors/rclone/notices/ ./notices/
RUN go run ./notices /out/licenses && cp /usr/local/go/LICENSE /out/licenses/Go.txt
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-X github.com/rclone/rclone/fs.Version=v1.75.2-gameshelf" -o /out/rclone . \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -tags connector_testservers -o /out/rclone-test .

# Build stage
FROM golang:1.27.3-alpine3.24 AS build
ARG GAMESHELF_SECURITY_EPOCH=development
RUN apk upgrade --no-cache && apk add --no-cache openssh-client
COPY --from=connector-build /out/rclone-test /usr/local/bin/rclone

WORKDIR /app

# Copy only what Go needs to build, leave out go.sum as it's not used
COPY go.mod ./
RUN go mod download

COPY main.go restore.go setup.go network.go access.go menu_access.go profiles.go profile_backup.go profile_avatar.go profile_auth.go profile_guardian.go guardian_credentials.go guardian_removal.go profile_self.go wipe.go health.go refresh_limit.go ./
COPY web/ ./web/

ARG GAMESHELF_BUILD_VERSION=Development
ARG GAMESHELF_BUILD_CHANNEL=development
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags "-X main.buildVersion=${GAMESHELF_BUILD_VERSION} -X main.buildChannel=${GAMESHELF_BUILD_CHANNEL}" \
    -o gameshelf .

# Userspace NFS adapter; the app never mounts filesystems or needs extra capabilities.
FROM alpine:3.24.3 AS network-build
ARG GAMESHELF_SECURITY_EPOCH=development
RUN apk upgrade --no-cache && apk add --no-cache build-base libnfs-dev
COPY native/network-nfs.c /src/network-nfs.c
RUN cc -O2 -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE -pie \
    /src/network-nfs.c -Wl,-z,relro,-z,now -lnfs -o /gameshelf-nfs

# Runtime stage
FROM alpine:3.24.3
ARG GAMESHELF_SECURITY_EPOCH=development
# Apply security fixes published since the base image was built.
RUN apk upgrade --no-cache && apk add --no-cache libnfs openssh-client ca-certificates
WORKDIR /app

COPY --from=build /app/gameshelf .
COPY --from=network-build /gameshelf-nfs .
COPY --from=connector-build /out/rclone /usr/local/bin/rclone
COPY --from=connector-build /out/licenses /usr/share/licenses/gameshelf-network
RUN addgroup -S -g 10001 gameshelf \
    && adduser -S -D -H -u 10001 -G gameshelf -s /sbin/nologin gameshelf \
    && mkdir -p /data && chown 10001:10001 /data \
    && chmod 0555 /app /app/gameshelf /app/gameshelf-nfs /usr/local/bin/rclone

# Numeric IDs make bind-mount permissions predictable and allow runtime overrides.
# Keep the executable root-owned; the application only needs read access to games.
USER 10001:10001

# Docker creates writable state storage when no explicit /data mount is supplied.
VOLUME ["/data"]

# GameShelf always listens on 8080; Docker can map a different host port.
EXPOSE 8080

ENTRYPOINT ["/app/gameshelf"]
