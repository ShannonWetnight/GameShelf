# Test servers only. This image is never part of the GameShelf runtime.
FROM alpine:3.24.3
RUN apk upgrade --no-cache && apk add --no-cache samba-server samba-common-tools unfs3 rpcbind rclone openssl vsftpd netcat-openbsd \
    && adduser -D -H -h /fixture -u 10001 reader \
    && printf 'reader:fixture-password\n' | chpasswd \
    && printf 'fixture-password\nfixture-password\n' | smbpasswd -a -s reader \
    && mkdir -p /tls /run/samba /run/rpcbind /var/lib/rpcbind /var/run/vsftpd/empty \
    && openssl req -x509 -newkey rsa:2048 -nodes -keyout /tls/server.key -out /tls/server.crt \
       -days 2 -subj /CN=network-fixture -addext subjectAltName=DNS:network-fixture \
    && printf 'fixture-only-private-file\n' > /private.txt
COPY start.sh /start.sh
RUN sed -i 's/\r$//' /start.sh
ENTRYPOINT ["/bin/sh", "/start.sh"]
