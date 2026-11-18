#include <assert.h>

// Compile the real adapter with a disposable, deterministic libnfs fixture.
#define main network_nfs_main
#include "../native/network-nfs.c"
#undef main

static int stat_result;
static int reads;
static int closes;
static struct nfs_stat_64 opened;

int nfs_lstat64(struct nfs_context *nfs, const char *path, struct nfs_stat_64 *st) {
    (void)nfs;
    assert(!strcmp(path, "/Game") || !strcmp(path, "/Game/file.bin"));
    *st = (struct nfs_stat_64){.nfs_dev = 1, .nfs_ino = 2,
        .nfs_mode = !strcmp(path, "/Game") ? S_IFDIR : S_IFREG, .nfs_size = 7};
    return 0;
}

int nfs_open(struct nfs_context *nfs, const char *path, int flags, struct nfsfh **file) {
    (void)nfs;
    assert(!strcmp(path, "/Game/file.bin"));
    assert(flags == (O_RDONLY | O_NOFOLLOW));
    *file = (struct nfsfh *)&opened;
    return 0;
}

int nfs_fstat64(struct nfs_context *nfs, struct nfsfh *file, struct nfs_stat_64 *st) {
    (void)nfs;
    assert(file == (struct nfsfh *)&opened);
    *st = opened;
    return stat_result;
}

#ifdef LIBNFS_API_V2
int nfs_pread(struct nfs_context *nfs, struct nfsfh *file, void *buf, size_t count, uint64_t offset) {
#else
int nfs_pread(struct nfs_context *nfs, struct nfsfh *file, uint64_t offset, uint64_t count, void *buf) {
#endif
    (void)nfs;
    assert(file == (struct nfsfh *)&opened && offset == 1 && count == 3);
    memcpy(buf, "ixt", 3);
    ++reads;
    return 3;
}

int nfs_close(struct nfs_context *nfs, struct nfsfh *file) {
    (void)nfs;
    assert(file == (struct nfsfh *)&opened);
    ++closes;
    return 0;
}

int main(void) {
    const struct nfs_stat_64 expected = {.nfs_dev = 1, .nfs_ino = 2, .nfs_mode = S_IFREG, .nfs_size = 7};
    struct {
        struct nfs_stat_64 attributes;
        int result;
    } rejected[] = {
        {{.nfs_dev = 1, .nfs_ino = 3, .nfs_mode = S_IFREG, .nfs_size = 7}, 0},
        {{.nfs_dev = 2, .nfs_ino = 2, .nfs_mode = S_IFREG, .nfs_size = 7}, 0},
        {{.nfs_dev = 1, .nfs_ino = 2, .nfs_mode = S_IFDIR, .nfs_size = 7}, 0},
        {expected, -1},
    };
    for (size_t i = 0; i < sizeof(rejected) / sizeof(rejected[0]); ++i) {
        stat_result = rejected[i].result;
        opened = rejected[i].attributes;
        assert(cat(NULL, "Game/file.bin", 1, 3) < 0);
        assert(reads == 0 && closes == (int)i + 1);
    }
    int prior_closes = closes;
    stat_result = 0;
    opened = expected;
    assert(cat(NULL, "Game/file.bin", 1, 3) == 0);
    assert(reads == 1 && closes == prior_closes + 1);
    return 0;
}
