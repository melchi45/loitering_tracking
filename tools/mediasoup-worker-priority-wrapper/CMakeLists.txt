# mediasoup-worker-priority-wrapper (2026-07-22, Design_Mediasoup_Multi_Worker.md §7)
#
# Linux-only. The problem this solves (raising a child process's scheduling
# priority requires CAP_SYS_NICE on the CALLER, and Linux file capabilities —
# the only unprivileged way to grant that to a specific binary — are a
# Linux-specific mechanism) doesn't exist in the same form elsewhere:
#   - Windows: SetPriorityClass() lets a process raise its OWN children up to
#     HIGH_PRIORITY_CLASS without extra privilege — mediasoupEngine.js's
#     existing plain os.setPriority(workerPid, ...) parent-side call already
#     covers this natively, no wrapper needed.
#   - macOS: no unprivileged equivalent to Linux capabilities exists; raising
#     priority still requires root. Not worth a separate wrapper for a path
#     that still needs sudo either way — falls back to the same graceful
#     no-op as an unconfigured Linux host.
# So this CMake project intentionally builds nothing on non-Linux platforms.
cmake_minimum_required(VERSION 3.10)
project(mediasoup_worker_priority_wrapper C)

if(UNIX AND NOT APPLE)
  add_executable(mediasoup-worker-wrapper wrapper.c)
  install(TARGETS mediasoup-worker-wrapper RUNTIME DESTINATION ${CMAKE_CURRENT_SOURCE_DIR}/bin)
else()
  message(STATUS "mediasoup-worker-priority-wrapper: skipped — not applicable on this platform (see comment above)")
endif()
