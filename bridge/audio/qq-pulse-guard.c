/* SPDX-License-Identifier: GPL-3.0-only
 * Only preload into our isolated QQ AVHost process tree. This is an interposer,
 * not a PulseAudio implementation. Public ABI: PulseAudio v16.1 pulse/{def,sample,stream}.h.
 * QQ 3.2.28 ARM64 passes NULL buffer attributes to both connect functions,
 * otherwise producing roughly 2-second capture batches on a null sink.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { int format; uint32_t rate; uint8_t channels; } sample_spec;
typedef struct { uint32_t maxlength, tlength, prebuf, minreq, fragsize; } buffer_attr;
typedef int (*context_fn)(void *, const char *, int, const void *);
typedef int (*playback_fn)(void *, const char *, const buffer_attr *, int, const void *, void *);
typedef int (*record_fn)(void *, const char *, const buffer_attr *, int);
typedef const sample_spec *(*spec_fn)(const void *);
typedef size_t (*frame_size_fn)(const sample_spec *);
enum { DONT_MOVE = 0x0200, ADJUST_LATENCY = 0x2000, EARLY_REQUESTS = 0x4000, NOAUTOSPAWN = 1 };

/* Chromium loads its PPAPI plugin and dependencies into a local dlopen scope.
 * RTLD_NEXT alone cannot see that libpulse from a globally preloaded library.
 * NOLOAD obtains the already-loaded native dependency; never load another
 * Pulse implementation or start a server as a lookup fallback.
 */
static void *pulse_symbol(const char *name) {
    void *symbol = dlsym(RTLD_NEXT, name);
    if (symbol) return symbol;
    void *handle = dlopen("libpulse.so.0", RTLD_LAZY | RTLD_NOLOAD);
    if (!handle) return NULL;
    symbol = dlsym(handle, name);
    dlclose(handle);
    return symbol;
}

static int denied(const char *reason) {
    fprintf(stderr, "[KoishiRTCQQPulse] refused: %s\n", reason);
    errno = EACCES;
    return -1;
}

static int explicit_device(const char *value) {
    return value && *value && strcmp(value, "default") && value[0] != '@';
}

static int configured(void) {
    const char *source = getenv("KOISHI_RTC_QQ_PULSE_SOURCE");
    const char *sink = getenv("KOISHI_RTC_QQ_PULSE_SINK");
    const char *server = getenv("PULSE_SERVER");
    const char *latency = getenv("PULSE_LATENCY_MSEC");
    if (!explicit_device(source) || !explicit_device(sink) || !strcmp(source, sink))
        return denied("separate, explicit QQ Pulse source and sink are required");
    if (!server || strncmp(server, "unix:/", 6) || !server[6] || strpbrk(server, "\r\n\t "))
        return denied("PULSE_SERVER must name the isolated absolute Unix socket");
    if (latency && *latency)
        return denied("unset PULSE_LATENCY_MSEC; it would override the guarded fragment size");
    return 0;
}

/* A native explicit request smaller than our limit remains smaller. Keep zero
 * prebuffering (manual start/stop) intact. Never mutate the caller's structure.
 * The server negotiates actual latency; these are requested limits, not proof
 * of remote playback. 240 ms is the bounded per-stream storage ceiling.
 */
static uint32_t capped(uint32_t value, uint32_t limit, uint32_t frame) {
    if (!value || value == UINT32_MAX || value > limit) return limit;
    value -= value % frame;
    return value ? value : frame;
}

static int attributes(void *stream, const buffer_attr *original, buffer_attr *out, int record, int flags) {
    spec_fn get_spec = (spec_fn)pulse_symbol("pa_stream_get_sample_spec");
    frame_size_fn get_frame_size = (frame_size_fn)pulse_symbol("pa_frame_size");
    if (!get_spec || !get_frame_size) return denied("PulseAudio sample-format ABI is unavailable");
    const sample_spec *spec = get_spec(stream);
    if (!spec || spec->rate < 8000 || spec->rate > 192000 || !spec->channels || spec->channels > 32)
        return denied("invalid PulseAudio PCM sample specification");
    size_t frame_size = get_frame_size(spec);
    if (!frame_size || frame_size > 256) return denied("invalid PulseAudio frame size");
    if (flags & EARLY_REQUESTS) return denied("EARLY_REQUESTS is incompatible with bounded total latency");
    uint32_t frame = (uint32_t)frame_size;
    uint32_t fragment = (spec->rate / 50) * frame;
    uint32_t target = (spec->rate * 60 / 1000) * frame;
    uint32_t ceiling = (spec->rate * 240 / 1000) * frame;
    *out = original ? *original : (buffer_attr){UINT32_MAX, UINT32_MAX, UINT32_MAX, UINT32_MAX, UINT32_MAX};
    out->maxlength = capped(out->maxlength, ceiling, frame);
    if (record) {
        if (fragment > out->maxlength) fragment = out->maxlength;
        out->fragsize = capped(out->fragsize, fragment, frame);
    } else {
        if (target > out->maxlength) target = out->maxlength;
        out->tlength = capped(out->tlength, target, frame);
        if (fragment > out->tlength) fragment = out->tlength;
        out->minreq = capped(out->minreq, fragment, frame);
        if (out->prebuf != 0) out->prebuf = capped(out->prebuf, fragment, frame);
    }
    fprintf(stderr, "[KoishiRTCQQPulse] requested %s rate=%u channels=%u maxlength=%u tlength=%u minreq=%u prebuf=%u fragsize=%u pinned=1\n",
            record ? "capture" : "playback", spec->rate, spec->channels, out->maxlength,
            out->tlength, out->minreq, out->prebuf, out->fragsize);
    return 0;
}

int pa_context_connect(void *context, const char *server, int flags, const void *api) {
    if (configured() < 0) return -1;
    const char *expected = getenv("PULSE_SERVER");
    if (server && strcmp(server, expected)) return denied("QQ requested a different PulseAudio server");
    context_fn original = (context_fn)pulse_symbol("pa_context_connect");
    if (!original) return denied("PulseAudio context ABI is unavailable");
    return original(context, expected, flags | NOAUTOSPAWN, api);
}

int pa_stream_connect_playback(void *stream, const char *device, const buffer_attr *attrs,
                               int flags, const void *volume, void *sync_stream) {
    if (configured() < 0) return -1;
    if (!device || strcmp(device, getenv("KOISHI_RTC_QQ_PULSE_SINK")))
        return denied("QQ playback device differs from the isolated virtual sink");
    playback_fn original = (playback_fn)pulse_symbol("pa_stream_connect_playback");
    buffer_attr bounded;
    if (!original) return denied("PulseAudio playback ABI is unavailable");
    if (attributes(stream, attrs, &bounded, 0, flags) < 0) return -1;
    return original(stream, device, &bounded, flags | DONT_MOVE | ADJUST_LATENCY, volume, sync_stream);
}

int pa_stream_connect_record(void *stream, const char *device, const buffer_attr *attrs, int flags) {
    if (configured() < 0) return -1;
    if (!device || strcmp(device, getenv("KOISHI_RTC_QQ_PULSE_SOURCE")))
        return denied("QQ capture device differs from the isolated virtual source");
    record_fn original = (record_fn)pulse_symbol("pa_stream_connect_record");
    buffer_attr bounded;
    if (!original) return denied("PulseAudio capture ABI is unavailable");
    if (attributes(stream, attrs, &bounded, 1, flags) < 0) return -1;
    return original(stream, device, &bounded, flags | DONT_MOVE | ADJUST_LATENCY);
}
