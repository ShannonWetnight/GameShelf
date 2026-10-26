# Disposable security fixture only; never included in the application image.
FROM alpine:3.24.3
RUN apk upgrade --no-cache && apk add --no-cache samba-server samba-client samba-common-tools python3 \
    && adduser -D -H -u 10001 writer \
    && printf 'fixture-write-password\nfixture-write-password\n' | smbpasswd -a -s writer \
    && mkdir -p /run/samba /fixture
COPY smb.conf /etc/samba/smb.conf
COPY fixture.py /fixture.py
ENTRYPOINT ["smbd", "--foreground", "--no-process-group", "--configfile=/etc/samba/smb.conf"]
