/* Read-only userspace NFS adapter. No mounts, root privileges, or FUSE required. */
#define _POSIX_C_SOURCE 200809L
#include <nfsc/libnfs.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* NFSv3/v4 share these regular-file and directory type values. */
enum { GS_NFS_REGULAR = 1, GS_NFS_DIRECTORY = 2 };
static int first = 1;
static unsigned entries = 0;
static void quote(const char *s) {
    putchar('"');
    for (const unsigned char *p=(const unsigned char *)s; *p; p++) {
        if (*p=='"'||*p=='\\') { putchar('\\'); putchar(*p); }
        else if (*p<32) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}
static int safe_name(const char *s) {
    return *s && strcmp(s,".") && strcmp(s,"..") && !strchr(s,'/') && !strchr(s,'\\');
}
static int list(struct nfs_context *nfs, const char *directory, int recursive, unsigned depth) {
    if (depth>64) return -1;
    struct nfsdir *dir=NULL;
    if (nfs_opendir(nfs, *directory?directory:"/", &dir)<0) return -1;
    struct nfsdirent *entry;
    while ((entry=nfs_readdir(nfs,dir))) {
        if (!safe_name(entry->name)) continue;
        if (entry->type!=GS_NFS_REGULAR && entry->type!=GS_NFS_DIRECTORY) continue;
        if (++entries>200000 || entry->size>INT64_MAX) { nfs_closedir(nfs,dir);return -1; }
        size_t length=strlen(directory)+strlen(entry->name)+2;
        if (length>8192) { nfs_closedir(nfs,dir);return -1; }
        char *name=malloc(length);if(!name){nfs_closedir(nfs,dir);return -1;}
        snprintf(name,length,"%s%s%s",directory,*directory?"/":"",entry->name);
        int is_dir=entry->type==GS_NFS_DIRECTORY;
        char stamp[32]="";time_t seconds=entry->mtime.tv_sec;struct tm tm;
        if(gmtime_r(&seconds,&tm))strftime(stamp,sizeof(stamp),"%Y-%m-%dT%H:%M:%SZ",&tm);
        if(!first)putchar(',');
        first=0;
        fputs("{\"Path\":",stdout);quote(name);printf(",\"Size\":%" PRIu64 ",\"IsDir\":%s,\"ModTime\":",is_dir?0:entry->size,is_dir?"true":"false");quote(stamp);putchar('}');
        if(is_dir&&recursive&&list(nfs,name,recursive,depth+1)<0){free(name);nfs_closedir(nfs,dir);return -1;}
        free(name);
    }
    nfs_closedir(nfs,dir);return ferror(stdout)?-1:0;
}
static int cat(struct nfs_context *nfs, const char *relative, uint64_t offset, int64_t count) {
    char *copy=strdup(relative);if(!copy)return -1;
    char checked[8192]="";char *save=NULL;char *part=strtok_r(copy,"/",&save);
    while(part){if(!safe_name(part)||strlen(checked)+strlen(part)+2>=sizeof(checked)){free(copy);return -1;}strcat(checked,"/");strcat(checked,part);struct nfs_stat_64 st;if(nfs_lstat64(nfs,checked,&st)<0||S_ISLNK(st.nfs_mode)){free(copy);return -1;}part=strtok_r(NULL,"/",&save);if(part&&!S_ISDIR(st.nfs_mode)){free(copy);return -1;}if(!part&&!S_ISREG(st.nfs_mode)){free(copy);return -1;}}
    free(copy);if(!*checked)return -1;
    struct nfsfh *file=NULL;if(nfs_open(nfs,checked,O_RDONLY|O_NOFOLLOW,&file)<0)return -1;
    unsigned char buffer[65536];int result=0;
    while(count!=0){size_t amount=(count<0||count>(int64_t)sizeof(buffer))?sizeof(buffer):(size_t)count;
#ifdef LIBNFS_API_V2
        int received=nfs_pread(nfs,file,buffer,amount,offset);
#else
        int received=nfs_pread(nfs,file,offset,amount,buffer);
#endif
        if(received<0){result=-1;break;}if(received==0)break;
        if(fwrite(buffer,1,(size_t)received,stdout)!=(size_t)received){result=-1;break;}offset+=(uint64_t)received;if(count>0)count-=received;
    }
    nfs_close(nfs,file);return result;
}
int main(int argc,char **argv) {
    if(argc!=7)return 2;
    struct nfs_context *nfs=nfs_init_context();if(!nfs)return 2;
    struct nfs_url *url=nfs_parse_url_dir(nfs,argv[2]);if(!url){nfs_destroy_context(nfs);return 2;}
    nfs_set_timeout(nfs,10000);nfs_set_autoreconnect(nfs,0);
    int result=nfs_mount(nfs,url->server,url->path);
    if(result==0){if(!strcmp(argv[1],"list")){putchar('[');result=list(nfs,"",!strcmp(argv[4],"true"),0);putchar(']');}else if(!strcmp(argv[1],"cat")){result=cat(nfs,argv[3],strtoull(argv[5],NULL,10),strtoll(argv[6],NULL,10));}else result=-1;}
    if(result<0)fprintf(stderr,"NFS read failed: %s\n",nfs_get_error(nfs));
    nfs_destroy_url(url);nfs_destroy_context(nfs);return result<0?1:0;
}
