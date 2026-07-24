/*
 * mediasoup-worker-priority-wrapper (2026-07-22, Design_Mediasoup_Multi_Worker.md §7)
 *
 * Raising a process's OWN scheduling priority (a negative nice value) requires
 * CAP_SYS_NICE on the process making the setpriority() syscall — the capability
 * check is against the CALLER, not the target PID. mediasoupEngine.js originally
 * called os.setPriority(workerPid, ...) from Node's own main process against the
 * mediasoup-worker CHILD's pid, and granted CAP_SYS_NICE to the mediasoup-worker
 * BINARY via `setcap` — which does nothing for that call, because Node (the
 * caller) is what needs the capability, not the target. Confirmed live: setcap
 * applied and verified via `getcap`, restart still logged EACCES on every
 * worker.
 *
 * This wrapper is the standard fix for that class of problem: a tiny, single-
 * purpose binary that (1) receives CAP_SYS_NICE via `setcap` on ITSELF, so when
 * the kernel execve()s it those capabilities land in its own effective set,
 * (2) raises its OWN priority (self-targeting setpriority() is checked against
 * this same process, which now has the capability), (3) execve()s into the
 * real mediasoup-worker binary. A process's nice value is a property of the
 * process, not the loaded image, so it survives execve() unchanged — the real
 * mediasoup-worker inherits the already-elevated priority without ever needing
 * the capability itself.
 *
 * Best-effort only: if CAP_SYS_NICE hasn't been granted (fresh checkout, or on
 * a platform where this wrapper isn't built — see CMakeLists.txt), the
 * setpriority() call below simply fails and is ignored; the real worker still
 * launches at default priority, same graceful-degradation behavior as before.
 *
 * Env vars (both set by mediasoupEngine.js before spawning this wrapper):
 *   MEDIASOUP_WORKER_REAL_BIN — absolute path to the real mediasoup-worker binary.
 *     Required — mediasoup's own createWorker({ workerBin }) option spawns THIS
 *     wrapper with mediasoup's own generated flags as argv, so there's no other
 *     way to tell the wrapper which real binary to chain into.
 *   MEDIASOUP_WORKER_PRIORITY — nice value to request, -20 (highest)..19 (lowest).
 *     Defaults to -5 if unset/invalid — see mediasoupEngine.js's own default for
 *     the same reasoning (moderate boost, considerate of other users on a shared host).
 */

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/resource.h>
#include <errno.h>
#include <string.h>

int main(int argc, char *argv[]) {
    const char *real_bin = getenv("MEDIASOUP_WORKER_REAL_BIN");
    if (real_bin == NULL || real_bin[0] == '\0') {
        fprintf(stderr, "mediasoup-worker-wrapper: MEDIASOUP_WORKER_REAL_BIN not set\n");
        return 127;
    }

    int priority = -5;
    const char *priority_env = getenv("MEDIASOUP_WORKER_PRIORITY");
    if (priority_env != NULL && priority_env[0] != '\0') {
        char *end = NULL;
        long parsed = strtol(priority_env, &end, 10);
        if (end != priority_env && *end == '\0' && parsed >= -20 && parsed <= 19) {
            priority = (int)parsed;
        }
    }

    // Best-effort — ignore failure (e.g. CAP_SYS_NICE not granted yet).
    if (setpriority(PRIO_PROCESS, 0, priority) != 0) {
        fprintf(stderr, "mediasoup-worker-wrapper: setpriority(%d) failed: %s "
                "(run 'sudo setcap cap_sys_nice+ep' on this wrapper binary once) "
                "— continuing at default priority\n", priority, strerror(errno));
    }

    // Replace argv[0] with the real binary path; forward every other arg
    // (mediasoup's own generated flags) unchanged.
    argv[0] = (char *)real_bin;
    execv(real_bin, argv);

    // execv() only returns on failure.
    fprintf(stderr, "mediasoup-worker-wrapper: execv(%s) failed: %s\n", real_bin, strerror(errno));
    return 127;
}
