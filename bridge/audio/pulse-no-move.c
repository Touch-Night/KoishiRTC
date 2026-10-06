/* Pin PulseAudio streams to their explicitly selected device. pacat/parec do not
 * expose PA_STREAM_DONT_MOVE, so use this shim only in their child environments.
 * No PulseAudio headers or implementation code are copied here. ABI references:
 * https://www.freedesktop.org/software/pulseaudio/doxygen/stream_8h.html
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stddef.h>

typedef int (*connect_playback_fn)(void *, const char *, const void *, int, const void *, void *);
typedef int (*connect_record_fn)(void *, const char *, const void *, int);
enum { STREAM_DONT_MOVE = 0x0200 };

int pa_stream_connect_playback(void *stream, const char *device, const void *attrs,
                               int flags, const void *volume, void *sync_stream) {
    connect_playback_fn original = (connect_playback_fn)dlsym(RTLD_NEXT, "pa_stream_connect_playback");
    if (!original || !device || !*device) return -1;
    return original(stream, device, attrs, flags | STREAM_DONT_MOVE, volume, sync_stream);
}

int pa_stream_connect_record(void *stream, const char *device, const void *attrs, int flags) {
    connect_record_fn original = (connect_record_fn)dlsym(RTLD_NEXT, "pa_stream_connect_record");
    if (!original || !device || !*device) return -1;
    return original(stream, device, attrs, flags | STREAM_DONT_MOVE);
}
