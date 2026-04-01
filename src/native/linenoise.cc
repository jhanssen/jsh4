#include "linenoise.h"
#include <napi.h>
#include <uv.h>
#include <unistd.h>
#include <fcntl.h>
#include <string>

extern "C" {
#include "../../3rdparty/linenoise/linenoise.h"
}

namespace jsh {

struct LinenoiseCtx {
    uv_poll_t* poll = nullptr;
    struct linenoiseState ls = {};
    char buf[4096];
    Napi::FunctionReference onLine;
    Napi::FunctionReference completionCb;
    Napi::FunctionReference colorizeCb;
    std::string rpromptStr;
    bool active = false;
};

static LinenoiseCtx* g_ctx = nullptr;

static void completionCallback(const char* input, linenoiseCompletions* lc) {
    if (!g_ctx || g_ctx->completionCb.IsEmpty()) return;
    Napi::Env env = g_ctx->completionCb.Env();
    Napi::Value result = g_ctx->completionCb.Call({Napi::String::New(env, input)});
    if (result.IsArray()) {
        Napi::Array arr = result.As<Napi::Array>();
        for (uint32_t i = 0; i < arr.Length(); i++) {
            Napi::Value item = arr.Get(i);
            if (item.IsString()) {
                linenoiseAddCompletion(lc, item.As<Napi::String>().Utf8Value().c_str());
            }
        }
    }
}

static void colorizeCallbackC(const char* buf, char* colorized, size_t maxlen, size_t* out_len) {
    if (!g_ctx || g_ctx->colorizeCb.IsEmpty()) {
        size_t len = strlen(buf);
        if (len > maxlen) len = maxlen;
        memcpy(colorized, buf, len);
        *out_len = len;
        return;
    }
    Napi::Env env = g_ctx->colorizeCb.Env();
    Napi::Value result = g_ctx->colorizeCb.Call({Napi::String::New(env, buf)});
    if (result.IsString()) {
        std::string str = result.As<Napi::String>().Utf8Value();
        size_t len = str.size();
        if (len > maxlen) len = maxlen;
        memcpy(colorized, str.c_str(), len);
        *out_len = len;
    } else {
        size_t len = strlen(buf);
        if (len > maxlen) len = maxlen;
        memcpy(colorized, buf, len);
        *out_len = len;
    }
}

static void onPollClose(uv_handle_t* handle) {
    delete reinterpret_cast<uv_poll_t*>(handle);
}

static void pollCallback(uv_poll_t* handle, int status, int events) {
    LinenoiseCtx* ctx = static_cast<LinenoiseCtx*>(handle->data);
    if (!ctx->active) return;

    Napi::Env env = ctx->onLine.Env();
    Napi::HandleScope scope(env);

    if (status < 0) {
        uv_poll_stop(handle);
        uv_close((uv_handle_t*)handle, onPollClose);
        ctx->poll = nullptr;
        ctx->active = false;
        linenoiseEditStop(&ctx->ls);
        ctx->onLine.Call({env.Null()});
        return;
    }

    char* line = linenoiseEditFeed(&ctx->ls);
    int saved_errno = errno;
    if (line == linenoiseEditMore) return;

    uv_poll_stop(handle);
    uv_close((uv_handle_t*)handle, onPollClose);
    ctx->poll = nullptr;
    ctx->active = false;
    linenoiseEditStop(&ctx->ls);

    if (line != nullptr) {
        Napi::String str = Napi::String::New(env, line);
        linenoiseFree(line);
        ctx->onLine.Call({str});
    } else {
        ctx->onLine.Call({env.Null(), Napi::Number::New(env, saved_errno)});
    }
}

static Napi::Value Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "start(prompt: string, callback: function)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string prompt = info[0].As<Napi::String>().Utf8Value();

    if (!g_ctx) {
        g_ctx = new LinenoiseCtx();
    }

    if (g_ctx->active) {
        Napi::Error::New(env, "linenoise already active").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    g_ctx->onLine = Napi::Persistent(info[1].As<Napi::Function>());
    g_ctx->active = true;

    if (linenoiseEditStart(&g_ctx->ls, STDIN_FILENO, STDOUT_FILENO,
                           g_ctx->buf, sizeof(g_ctx->buf), prompt.c_str()) != 0) {
        g_ctx->active = false;
        Napi::Error::New(env, "linenoiseEditStart failed").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    uv_loop_t* loop;
    napi_get_uv_event_loop(env, &loop);

    g_ctx->poll = new uv_poll_t();
    uv_poll_init(loop, g_ctx->poll, g_ctx->ls.ifd);
    g_ctx->poll->data = g_ctx;
    uv_poll_start(g_ctx->poll, UV_READABLE, pollCallback);

    return env.Undefined();
}

static Napi::Value Stop(const Napi::CallbackInfo& info) {
    if (g_ctx && g_ctx->active && g_ctx->poll) {
        uv_poll_stop(g_ctx->poll);
        uv_close((uv_handle_t*)g_ctx->poll, onPollClose);
        g_ctx->poll = nullptr;
        linenoiseEditStop(&g_ctx->ls);
        g_ctx->active = false;
    }
    return info.Env().Undefined();
}

static Napi::Value SetCompletion(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_ctx) g_ctx = new LinenoiseCtx();

    if (info.Length() < 1 || info[0].IsNull() || info[0].IsUndefined()) {
        g_ctx->completionCb.Reset();
        linenoiseSetCompletionCallback(nullptr);
    } else if (info[0].IsFunction()) {
        g_ctx->completionCb = Napi::Persistent(info[0].As<Napi::Function>());
        linenoiseSetCompletionCallback(completionCallback);
    } else {
        Napi::TypeError::New(env, "Expected function or null").ThrowAsJavaScriptException();
    }
    return env.Undefined();
}

static Napi::Value Hide(const Napi::CallbackInfo& info) {
    if (g_ctx && g_ctx->active) linenoiseHide(&g_ctx->ls);
    return info.Env().Undefined();
}

static Napi::Value Show(const Napi::CallbackInfo& info) {
    if (g_ctx && g_ctx->active) linenoiseShow(&g_ctx->ls);
    return info.Env().Undefined();
}

static Napi::Value HistoryAdd(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    linenoiseHistoryAdd(info[0].As<Napi::String>().Utf8Value().c_str());
    return env.Undefined();
}

static Napi::Value HistorySetMaxLen(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected number").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    linenoiseHistorySetMaxLen(info[0].As<Napi::Number>().Int32Value());
    return env.Undefined();
}

static Napi::Value HistorySave(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int ret = linenoiseHistorySave(info[0].As<Napi::String>().Utf8Value().c_str());
    return Napi::Number::New(env, ret);
}

static Napi::Value HistoryLoad(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int ret = linenoiseHistoryLoad(info[0].As<Napi::String>().Utf8Value().c_str());
    return Napi::Number::New(env, ret);
}

// --- Test helpers ---

static Napi::Value CreatePipe(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int fds[2];
    if (pipe(fds) != 0) {
        Napi::Error::New(env, "pipe() failed").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Array arr = Napi::Array::New(env, 2);
    arr.Set(0u, Napi::Number::New(env, fds[0]));
    arr.Set(1u, Napi::Number::New(env, fds[1]));
    return arr;
}

static Napi::Value DupFd(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected number").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int newfd = dup(info[0].As<Napi::Number>().Int32Value());
    if (newfd < 0) {
        Napi::Error::New(env, "dup() failed").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::Number::New(env, newfd);
}

static Napi::Value Dup2Fd(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "Expected (srcFd: number, dstFd: number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int src = info[0].As<Napi::Number>().Int32Value();
    int dst = info[1].As<Napi::Number>().Int32Value();
    if (dup2(src, dst) < 0) {
        Napi::Error::New(env, "dup2() failed").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return env.Undefined();
}

static Napi::Value CloseFd(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected number").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    close(info[0].As<Napi::Number>().Int32Value());
    return env.Undefined();
}

static Napi::Value WriteFd(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
        Napi::TypeError::New(env, "Expected (fd: number, data: string)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    int fd = info[0].As<Napi::Number>().Int32Value();
    std::string data = info[1].As<Napi::String>().Utf8Value();
    write(fd, data.c_str(), data.size());
    return env.Undefined();
}

static Napi::Value SetColorize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_ctx) g_ctx = new LinenoiseCtx();
    if (info.Length() > 0 && info[0].IsFunction()) {
        g_ctx->colorizeCb = Napi::Persistent(info[0].As<Napi::Function>());
        linenoiseSetColorizeCallback(colorizeCallbackC);
    } else {
        g_ctx->colorizeCb.Reset();
        linenoiseSetColorizeCallback(NULL);
    }
    return env.Undefined();
}

static Napi::Value SetRightPrompt(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_ctx) g_ctx = new LinenoiseCtx();
    if (info.Length() > 0 && info[0].IsString()) {
        g_ctx->rpromptStr = info[0].As<Napi::String>().Utf8Value();
        linenoiseSetRightPrompt(&g_ctx->ls, g_ctx->rpromptStr.c_str());
    } else {
        g_ctx->rpromptStr.clear();
        linenoiseSetRightPrompt(&g_ctx->ls, NULL);
    }
    return env.Undefined();
}

Napi::Object InitLinenoise(Napi::Env env, Napi::Object exports) {
    exports.Set("linenoiseStart",         Napi::Function::New(env, Start));
    exports.Set("linenoiseStop",          Napi::Function::New(env, Stop));
    exports.Set("linenoiseSetCompletion", Napi::Function::New(env, SetCompletion));
    exports.Set("linenoiseSetColorize",  Napi::Function::New(env, SetColorize));
    exports.Set("linenoiseSetRightPrompt", Napi::Function::New(env, SetRightPrompt));
    exports.Set("linenoiseHide",          Napi::Function::New(env, Hide));
    exports.Set("linenoiseShow",          Napi::Function::New(env, Show));
    exports.Set("linenoiseHistoryAdd",    Napi::Function::New(env, HistoryAdd));
    exports.Set("linenoiseHistorySetMaxLen", Napi::Function::New(env, HistorySetMaxLen));
    exports.Set("linenoiseHistorySave",   Napi::Function::New(env, HistorySave));
    exports.Set("linenoiseHistoryLoad",   Napi::Function::New(env, HistoryLoad));
    // Test helpers
    exports.Set("createPipe",             Napi::Function::New(env, CreatePipe));
    exports.Set("dupFd",                  Napi::Function::New(env, DupFd));
    exports.Set("dup2Fd",                 Napi::Function::New(env, Dup2Fd));
    exports.Set("closeFd",               Napi::Function::New(env, CloseFd));
    exports.Set("writeFd",               Napi::Function::New(env, WriteFd));
    return exports;
}

} // namespace jsh
