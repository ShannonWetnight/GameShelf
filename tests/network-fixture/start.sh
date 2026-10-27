#!/bin/sh
set -eu
# Used only by the disposable containment characterization. Deliberately allow
# server-side links inside the exported namespace so client/server boundaries
# are observable; ordinary smoke fixtures retain their stricter defaults.
if [ "${GAMESHELF_CONTAINMENT_FIXTURE:-0}" = 1 ]; then
    export RCLONE_LOCAL_COPY_LINKS=true
fi
cat > /etc/samba/smb.conf <<'CONFIG'
[global]
server role = standalone server
security = user
map to guest = Never
server min protocol = SMB2
disable netbios = yes
smb ports = 445
log level = 0
follow symlinks = no
[games]
path = /fixture
read only = yes
valid users = reader
CONFIG
if [ "${GAMESHELF_CONTAINMENT_FIXTURE:-0}" = 1 ]; then
    sed -i 's/follow symlinks = no/follow symlinks = yes/' /etc/samba/smb.conf
fi
printf '/fixture (ro,insecure,all_squash,anonuid=10001,anongid=10001)\n' > /etc/exports
rpcbind -f -w &
until nc -z 127.0.0.1 111; do sleep .1; done
unfsd -d -e /etc/exports &
smbd --foreground --no-process-group --configfile=/etc/samba/smb.conf &
if [ "${GAMESHELF_CONTAINMENT_FIXTURE:-0}" = 1 ]; then
    # Preserve actual SFTP link metadata. A VFS server backed by copy-links
    # would hide those links before the client could exercise skip_links.
    ssh-keygen -A
    cat > /tmp/containment-sshd.conf <<'CONFIG'
Port 2022
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication yes
AllowUsers reader
ChrootDirectory /fixture
ForceCommand internal-sftp
Subsystem sftp internal-sftp
PidFile /run/containment-sshd.pid
CONFIG
    /usr/sbin/sshd -D -e -f /tmp/containment-sshd.conf &
else
    rclone serve sftp /fixture --addr :2022 --user reader --pass fixture-password --read-only --log-level ERROR &
fi
rclone serve webdav /fixture --addr :8085 --user reader --pass fixture-password --read-only --log-level ERROR &
rclone serve ftp /fixture --addr :2121 --user reader --pass fixture-password --read-only --passive-port 32000-32010 --log-level ERROR &
cat > /etc/vsftpd/vsftpd.conf <<'CONFIG'
listen=YES
background=NO
listen_port=990
secure_chroot_dir=/var/run/vsftpd/empty
check_shell=NO
xferlog_enable=YES
log_ftp_protocol=YES
anonymous_enable=NO
local_enable=YES
write_enable=NO
local_root=/fixture
chroot_local_user=YES
allow_writeable_chroot=YES
seccomp_sandbox=NO
isolate=NO
isolate_network=NO
ssl_enable=YES
implicit_ssl=YES
require_ssl_reuse=NO
rsa_cert_file=/tls/server.crt
rsa_private_key_file=/tls/server.key
force_local_data_ssl=YES
force_local_logins_ssl=YES
pasv_enable=YES
pasv_min_port=31000
pasv_max_port=31010
pasv_addr_resolve=YES
pasv_address=network-fixture
userlist_enable=NO
CONFIG
vsftpd /etc/vsftpd/vsftpd.conf &
wait
