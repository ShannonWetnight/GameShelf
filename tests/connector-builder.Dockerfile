# Edge-only fixture connector; never part of the production Dockerfile.
FROM gameshelf:builder AS connector-tests
WORKDIR /connector
COPY connectors/rclone/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -tags connector_testservers -o /out/rclone .
FROM gameshelf:builder
COPY --from=connector-tests /out/rclone /usr/local/bin/rclone
