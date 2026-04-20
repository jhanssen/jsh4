#include "input-engine.h"
#include "history-writer.h"
#include <jinput.h>
#include <uv.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <pwd.h>
#include <grp.h>
#include <unistd.h>
#if defined(__APPLE__) || defined(__linux__)
#include <sys/xattr.h>
#endif

extern "C" {
#include <grapheme.h>
}

namespace jsh {

// ---- Grapheme char_funcs ---------------------------------------------------

static size_t grapheme_next_len_cb(const char *buf, size_t pos, size_t len) {
    if (pos >= len) {
        return 0;
    }
    return grapheme_next_character_break_utf8(buf + pos, len - pos);
}

static size_t grapheme_prev_len_cb(const char *buf, size_t pos, size_t from) {
    if (pos == 0 || pos <= from) {
        return 0;
    }
    size_t prev = from;
    size_t cur = from;
    while (cur < pos) {
        prev = cur;
        size_t step = grapheme_next_character_break_utf8(buf + cur, pos - cur);
        if (step == 0) {
            step = 1;
        }
        cur += step;
    }
    return pos - prev;
}

static uint32_t decode_cp(const char *s, size_t *blen, size_t avail) {
    unsigned char c = static_cast<unsigned char>(s[0]);
    if (c < 0x80) {
        *blen = 1;
        return c;
    }
    if (c < 0xE0) {
        *blen = 2;
        if (avail < 2) {
            *blen = 1;
            return 0xFFFD;
        }
        return ((c & 0x1F) << 6) | (s[1] & 0x3F);
    }
    if (c < 0xF0) {
        *blen = 3;
        if (avail < 3) {
            *blen = 1;
            return 0xFFFD;
        }
        return ((c & 0x0F) << 12) | ((s[1] & 0x3F) << 6) | (s[2] & 0x3F);
    }
    *blen = 4;
    if (avail < 4) {
        *blen = 1;
        return 0xFFFD;
    }
    return ((c & 0x07) << 18) | ((s[1] & 0x3F) << 12) | ((s[2] & 0x3F) << 6) | (s[3] & 0x3F);
}

static int cp_width(uint32_t cp) {
    if (cp == 0) {
        return 0;
    }
    if ((cp >= 0x0300 && cp <= 0x036F) || (cp >= 0x1AB0 && cp <= 0x1AFF) ||
        (cp >= 0x1DC0 && cp <= 0x1DFF) || (cp >= 0x20D0 && cp <= 0x20FF) ||
        (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xFE20 && cp <= 0xFE2F) ||
        (cp >= 0xE0100 && cp <= 0xE01EF) || cp == 0x200B || cp == 0x200C ||
        cp == 0x200D || cp == 0xFEFF) {
        return 0;
    }
    if ((cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x303E) ||
        (cp >= 0x3040 && cp <= 0x33BF) || (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0xFE30 && cp <= 0xFE6F) || (cp >= 0xFF01 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x20000 && cp <= 0x2FFFF) ||
        (cp >= 0x30000 && cp <= 0x3FFFF) || (cp >= 0x1F000 && cp <= 0x1FFFF) ||
        (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)) {
        return 2;
    }
    if (cp < 0x20) {
        return 0;
    }
    return 1;
}

static int grapheme_cluster_width_cb(const char *s, size_t clen) {
    if (clen == 0) {
        return 0;
    }
    size_t blen = 0;
    uint32_t baseCp = decode_cp(s, &blen, clen);
    int w = cp_width(baseCp);
    size_t i = blen;
    while (i < clen) {
        uint32_t cp = decode_cp(s + i, &blen, clen - i);
        if (cp == 0xFE0F && w == 1) {
            w = 2;
        }
        i += blen;
    }
    return w;
}

// ---- History bridge (jsh::hist_writer uses a worker thread + flock) --------

static int history_load_cb(void *ud, const char *filename,
                           void (*add_entry)(void *, const char *),
                           void *add_ud) {
    (void)ud;
    auto status = jsh::hist_writer::load(
        std::string(filename ? filename : ""),
        [add_entry, add_ud](const std::string &entry) {
            add_entry(add_ud, entry.c_str());
        });
    return status == jsh::hist_writer::LoadStatus::Ok ? 0 : -1;
}

static void history_append_cb(void *ud, const char *line) {
    (void)ud;
    if (line) {
        jsh::hist_writer::enqueue(std::string(line));
    }
}

static void history_flush_cb(void *ud) {
    (void)ud;
    jsh::hist_writer::shutdown(1000);
}

// ---- Engine context --------------------------------------------------------

struct EngineCtx {
    uv_poll_t *poll = nullptr;
    Napi::FunctionReference onLine;
    Napi::FunctionReference onRender;
    Napi::FunctionReference onCompletion;
    Napi::FunctionReference onEscResponse;
    jinput_t *engine = nullptr;
};

static EngineCtx *g_ctx = nullptr;

// ---- jinput callback trampolines → NAPI ------------------------------------

static void on_line_cb(const char *line, int errno_val, void *userdata) {
    (void)userdata;
    if (!g_ctx) {
        return;
    }
    Napi::Env env = g_ctx->onLine.Env();
    Napi::HandleScope scope(env);
    if (line) {
        g_ctx->onLine.Call({Napi::String::New(env, line)});
    } else {
        g_ctx->onLine.Call({env.Null(), Napi::Number::New(env, errno_val)});
    }
}

static void on_render_cb(const jinput_render_state_t *state, void *userdata) {
    (void)userdata;
    if (!g_ctx || g_ctx->onRender.IsEmpty()) {
        return;
    }
    Napi::Env env = g_ctx->onRender.Env();
    Napi::HandleScope scope(env);
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("buf", Napi::String::New(env, state->buf, state->len));
    obj.Set("pos", Napi::Number::New(env, static_cast<double>(state->pos)));
    obj.Set("len", Napi::Number::New(env, static_cast<double>(state->len)));
    obj.Set("cols", Napi::Number::New(env, static_cast<double>(state->cols)));
    obj.Set("suggestionId", Napi::Number::New(env, static_cast<double>(state->suggestion_id)));
    if (state->suggestion) {
        obj.Set("suggestion", Napi::String::New(env, state->suggestion));
    }
    if (state->search_query) {
        obj.Set("searchQuery", Napi::String::New(env, state->search_query));
        obj.Set("searchMatch", Napi::Boolean::New(env, state->search_match != 0));
    }
    if (state->line_search_query) {
        obj.Set("lineSearchQuery", Napi::String::New(env, state->line_search_query));
    }
    if (state->completion_desc) {
        obj.Set("completionDesc", Napi::String::New(env, state->completion_desc));
    }
    if (state->menu_lines && state->menu_line_count > 0) {
        Napi::Array arr = Napi::Array::New(env, state->menu_line_count);
        for (size_t i = 0; i < state->menu_line_count; i++) {
            arr.Set(i, Napi::String::New(env, state->menu_lines[i]));
        }
        obj.Set("menuLines", arr);
    }
    g_ctx->onRender.Call({obj});
}

static std::vector<std::string> extract_array(Napi::Array arr) {
    std::vector<std::string> v;
    for (uint32_t i = 0; i < arr.Length(); i++) {
        Napi::Value item = arr.Get(i);
        if (item.IsString()) {
            v.push_back(item.As<Napi::String>().Utf8Value());
        }
    }
    return v;
}

static jinput_completions_t *on_completion_cb(const char *buf, size_t pos, void *userdata) {
    (void)userdata;
    if (!g_ctx || g_ctx->onCompletion.IsEmpty()) {
        return nullptr;
    }
    Napi::Env env = g_ctx->onCompletion.Env();
    Napi::HandleScope scope(env);
    Napi::Value result = g_ctx->onCompletion.Call({
        Napi::String::New(env, buf),
        Napi::Number::New(env, static_cast<double>(pos)),
    });

    if (result.IsPromise()) {
        return nullptr;
    }

    std::vector<std::string> entries;
    std::vector<std::string> displays;
    std::vector<std::string> types;
    size_t replaceStart = 0;
    size_t replaceEnd = 0;
    bool ambiguous = false;

    if (result.IsArray()) {
        entries = extract_array(result.As<Napi::Array>());
        replaceStart = 0;
        replaceEnd = pos;
        size_t blen = strlen(buf);
        while (replaceEnd < blen && !std::isspace(static_cast<unsigned char>(buf[replaceEnd]))) {
            replaceEnd++;
        }
    } else if (result.IsObject() && !result.IsPromise()) {
        Napi::Object obj = result.As<Napi::Object>();
        if (obj.Has("entries") && obj.Get("entries").IsArray()) {
            entries = extract_array(obj.Get("entries").As<Napi::Array>());
        }
        if (obj.Has("displays") && obj.Get("displays").IsArray()) {
            displays = extract_array(obj.Get("displays").As<Napi::Array>());
        }
        if (obj.Has("types") && obj.Get("types").IsArray()) {
            types = extract_array(obj.Get("types").As<Napi::Array>());
        }
        replaceStart = obj.Has("replaceStart") && obj.Get("replaceStart").IsNumber()
                           ? obj.Get("replaceStart").As<Napi::Number>().Uint32Value()
                           : pos;
        replaceEnd = obj.Has("replaceEnd") && obj.Get("replaceEnd").IsNumber()
                         ? obj.Get("replaceEnd").As<Napi::Number>().Uint32Value()
                         : pos;
        if (obj.Has("ambiguous") && obj.Get("ambiguous").IsBoolean()) {
            ambiguous = obj.Get("ambiguous").As<Napi::Boolean>().Value();
        }
    } else {
        return nullptr;
    }

    if (entries.empty()) {
        return nullptr;
    }

    auto *c = static_cast<jinput_completions_t *>(calloc(1, sizeof(jinput_completions_t)));
    c->count = entries.size();
    c->entries = static_cast<char **>(calloc(c->count, sizeof(char *)));
    c->displays = static_cast<char **>(calloc(c->count, sizeof(char *)));
    c->descriptions = nullptr;
    c->types = static_cast<char **>(calloc(c->count, sizeof(char *)));
    for (size_t i = 0; i < c->count; i++) {
        c->entries[i] = strdup(entries[i].c_str());
        if (i < displays.size() && !displays[i].empty()) {
            c->displays[i] = strdup(displays[i].c_str());
        } else {
            c->displays[i] = strdup("");
        }
        if (i < types.size() && !types[i].empty()) {
            c->types[i] = strdup(types[i].c_str());
        } else {
            c->types[i] = strdup("");
        }
    }
    c->replace_start = replaceStart;
    c->replace_end = replaceEnd;
    c->ambiguous = ambiguous ? 1 : 0;
    return c;
}

static void on_esc_response_cb(const char *type, const char *payload, void *userdata) {
    (void)userdata;
    if (!g_ctx || g_ctx->onEscResponse.IsEmpty()) {
        return;
    }
    Napi::Env env = g_ctx->onEscResponse.Env();
    Napi::HandleScope scope(env);
    g_ctx->onEscResponse.Call({
        Napi::String::New(env, type),
        Napi::String::New(env, payload),
    });
}

// ---- libuv poll driving jinput_feed ---------------------------------------

static void onPollClose(uv_handle_t *handle) {
    delete reinterpret_cast<uv_poll_t *>(handle);
}

static void pollCallback(uv_poll_t *handle, int status, int events) {
    (void)handle;
    if (!g_ctx || !g_ctx->engine) {
        return;
    }
    if (status < 0 || !(events & UV_READABLE)) {
        return;
    }
    int result = jinput_feed(g_ctx->engine);
    if (result == 0) {
        return;
    }
    if (g_ctx->poll) {
        uv_poll_stop(g_ctx->poll);
        uv_close(reinterpret_cast<uv_handle_t *>(g_ctx->poll), onPollClose);
        g_ctx->poll = nullptr;
    }
}

// ---- NAPI: input control ---------------------------------------------------

static void ensure_engine() {
    if (!g_ctx) {
        g_ctx = new EngineCtx();
    }
    if (!g_ctx->engine) {
        g_ctx->engine = jinput_create();

        jinput_char_funcs_t cf = {};
        cf.next_len = grapheme_next_len_cb;
        cf.prev_len = grapheme_prev_len_cb;
        cf.cluster_width = grapheme_cluster_width_cb;
        jinput_set_char_funcs(g_ctx->engine, &cf);

        jinput_history_funcs_t hf = {};
        hf.load = history_load_cb;
        hf.append = history_append_cb;
        hf.flush = history_flush_cb;
        jinput_set_history_funcs(g_ctx->engine, &hf);
    }
}

static Napi::Value InputStart(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "inputStart(callbacks)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object cbs = info[0].As<Napi::Object>();

    ensure_engine();

    g_ctx->onLine = Napi::Persistent(cbs.Get("onLine").As<Napi::Function>());
    g_ctx->onRender = Napi::Persistent(cbs.Get("onRender").As<Napi::Function>());
    if (cbs.Has("onCompletion") && cbs.Get("onCompletion").IsFunction()) {
        g_ctx->onCompletion = Napi::Persistent(cbs.Get("onCompletion").As<Napi::Function>());
    }
    if (cbs.Has("onEscResponse") && cbs.Get("onEscResponse").IsFunction()) {
        g_ctx->onEscResponse = Napi::Persistent(cbs.Get("onEscResponse").As<Napi::Function>());
    }

    jinput_callbacks_t jcbs = {};
    jcbs.on_line = on_line_cb;
    jcbs.on_render = on_render_cb;
    jcbs.on_completion = g_ctx->onCompletion.IsEmpty() ? nullptr : on_completion_cb;
    jcbs.on_esc_response = g_ctx->onEscResponse.IsEmpty() ? nullptr : on_esc_response_cb;
    jcbs.userdata = nullptr;

    int rc = jinput_start(g_ctx->engine, &jcbs);
    if (rc == -1) {
        Napi::Error::New(env, "Failed to enable raw mode").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (isatty(STDIN_FILENO) || getenv("LINENOISE_ASSUME_TTY")) {
        uv_loop_t *loop;
        napi_get_uv_event_loop(env, &loop);
        g_ctx->poll = new uv_poll_t();
        g_ctx->poll->data = g_ctx;
        uv_poll_init(loop, g_ctx->poll, jinput_get_fd(g_ctx->engine));
        uv_poll_start(g_ctx->poll, UV_READABLE, pollCallback);
    }

    return env.Undefined();
}

static Napi::Value InputStop(const Napi::CallbackInfo &info) {
    if (g_ctx) {
        if (g_ctx->poll) {
            uv_poll_stop(g_ctx->poll);
            uv_close(reinterpret_cast<uv_handle_t *>(g_ctx->poll), onPollClose);
            g_ctx->poll = nullptr;
        }
        if (g_ctx->engine) {
            jinput_stop(g_ctx->engine);
        }
    }
    return info.Env().Undefined();
}

static Napi::Value InputGetCols(const Napi::CallbackInfo &info) {
    return Napi::Number::New(info.Env(), jinput_get_cols());
}

static Napi::Value InputWriteRaw(const Napi::CallbackInfo &info) {
    if (info.Length() < 1) {
        return info.Env().Undefined();
    }
    if (info[0].IsString()) {
        std::string data = info[0].As<Napi::String>().Utf8Value();
        jinput_write_raw(STDOUT_FILENO, data.c_str(), data.size());
    } else if (info[0].IsBuffer()) {
        Napi::Buffer<char> buf = info[0].As<Napi::Buffer<char>>();
        jinput_write_raw(STDOUT_FILENO, buf.Data(), buf.Length());
    }
    return info.Env().Undefined();
}

static Napi::Value InputRenderLine(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 6) {
        Napi::TypeError::New(env, "inputRenderLine(prompt, colorized, rprompt, cols, rawBuf, rawPos)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string prompt = info[0].As<Napi::String>().Utf8Value();
    std::string colorized = info[1].As<Napi::String>().Utf8Value();
    std::string rprompt = info[2].As<Napi::String>().Utf8Value();
    int cols = info[3].As<Napi::Number>().Int32Value();
    std::string rawBufStr = info[4].As<Napi::String>().Utf8Value();
    size_t rawPos = static_cast<size_t>(info[5].As<Napi::Number>().Int64Value());

    ensure_engine();

    jinput_render_line_result_t r = jinput_render_line(
        g_ctx->engine, prompt.c_str(), colorized.c_str(), rprompt.c_str(),
        cols, rawBufStr.c_str(), rawPos);

    Napi::Object result = Napi::Object::New(env);
    result.Set("line", Napi::String::New(env, r.line ? r.line : ""));
    result.Set("cursorCol", Napi::Number::New(env, static_cast<double>(r.cursor_col)));
    free(r.line);
    return result;
}

// ---- NAPI: history ---------------------------------------------------------

static Napi::Value HistoryAdd(const Napi::CallbackInfo &info) {
    ensure_engine();
    if (info.Length() > 0 && info[0].IsString()) {
        jinput_history_add(g_ctx->engine, info[0].As<Napi::String>().Utf8Value().c_str());
    }
    return info.Env().Undefined();
}

static Napi::Value HistorySetMaxLen(const Napi::CallbackInfo &info) {
    ensure_engine();
    if (info.Length() > 0 && info[0].IsNumber()) {
        jinput_history_set_max_len(g_ctx->engine, info[0].As<Napi::Number>().Int32Value());
    }
    return info.Env().Undefined();
}

static Napi::Value HistorySave(const Napi::CallbackInfo &info) {
    ensure_engine();
    jinput_history_save(g_ctx->engine);
    return info.Env().Undefined();
}

static Napi::Value HistoryLoad(const Napi::CallbackInfo &info) {
    ensure_engine();
    if (info.Length() > 0 && info[0].IsString()) {
        return Napi::Number::New(info.Env(),
                                 jinput_history_load(g_ctx->engine,
                                                     info[0].As<Napi::String>().Utf8Value().c_str()));
    }
    return Napi::Number::New(info.Env(), -1);
}

static Napi::Value HistoryCount(const Napi::CallbackInfo &info) {
    ensure_engine();
    return Napi::Number::New(info.Env(), jinput_history_count(g_ctx->engine));
}

static Napi::Value HistoryGet(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        return env.Null();
    }
    ensure_engine();
    int idx = info[0].As<Napi::Number>().Int32Value();
    const char *entry = jinput_history_get(g_ctx->engine, idx);
    if (!entry) {
        return env.Null();
    }
    return Napi::String::New(env, entry);
}

static Napi::Value HistoryAll(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    ensure_engine();
    int n = 0;
    jinput_history_all(g_ctx->engine, &n);
    Napi::Array arr = Napi::Array::New(env, n);
    for (int i = 0; i < n; i++) {
        const char *e = jinput_history_get(g_ctx->engine, i);
        arr.Set(static_cast<uint32_t>(i), Napi::String::New(env, e ? e : ""));
    }
    return arr;
}

static Napi::Value HistorySearchPrefix(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        return env.Null();
    }
    ensure_engine();
    const char *result = jinput_history_search_prefix(
        g_ctx->engine, info[0].As<Napi::String>().Utf8Value().c_str());
    if (!result) {
        return env.Null();
    }
    return Napi::String::New(env, result);
}

// ---- NAPI: buffer / completion config --------------------------------------

static Napi::Value SetSuggestion(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
        return env.Undefined();
    }
    ensure_engine();
    uint32_t id = info[0].As<Napi::Number>().Uint32Value();
    std::string text = info[1].As<Napi::String>().Utf8Value();
    jinput_set_suggestion(g_ctx->engine, id, text.c_str());
    return env.Undefined();
}

static Napi::Value SetInput(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        return env.Undefined();
    }
    ensure_engine();
    jinput_set_input(g_ctx->engine, info[0].As<Napi::String>().Utf8Value().c_str());
    return env.Undefined();
}

static Napi::Value SetWordChars(const Napi::CallbackInfo &info) {
    if (info.Length() >= 1 && info[0].IsString()) {
        ensure_engine();
        jinput_set_word_chars(g_ctx->engine, info[0].As<Napi::String>().Utf8Value().c_str());
    }
    return info.Env().Undefined();
}

static Napi::Value SetCompletionStyle(const Napi::CallbackInfo &info) {
    if (info.Length() >= 1 && info[0].IsString()) {
        ensure_engine();
        jinput_set_completion_style(g_ctx->engine, info[0].As<Napi::String>().Utf8Value().c_str());
    }
    return info.Env().Undefined();
}

static Napi::Value SetListColors(const Napi::CallbackInfo &info) {
    ensure_engine();
    if (info.Length() >= 1 && info[0].IsString()) {
        jinput_set_list_colors(g_ctx->engine, info[0].As<Napi::String>().Utf8Value().c_str());
    } else {
        jinput_set_list_colors(g_ctx->engine, "");
    }
    return info.Env().Undefined();
}

static Napi::Value ColorForFile(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        return Napi::String::New(env, "");
    }
    ensure_engine();
    const char *result = jinput_color_for_file(
        g_ctx->engine,
        info[0].As<Napi::String>().Utf8Value().c_str(),
        info[1].As<Napi::String>().Utf8Value().c_str());
    return Napi::String::New(env, result ? result : "");
}

static Napi::Value SetCompletions(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    ensure_engine();

    auto extract = [](Napi::Array arr) -> std::vector<std::string> {
        std::vector<std::string> v;
        for (uint32_t i = 0; i < arr.Length(); i++) {
            Napi::Value item = arr.Get(i);
            if (item.IsString()) {
                v.push_back(item.As<Napi::String>().Utf8Value());
            } else {
                v.push_back("");
            }
        }
        return v;
    };

    std::vector<std::string> entries;
    std::vector<std::string> descs;
    std::vector<std::string> displays;
    std::vector<std::string> types;
    int rs = -1;
    int re = -1;
    int ambiguous = 0;

    if (info.Length() > 0 && info[0].IsArray()) {
        entries = extract(info[0].As<Napi::Array>());
    }
    if (info.Length() > 1 && info[1].IsArray()) {
        descs = extract(info[1].As<Napi::Array>());
    }
    if (info.Length() > 2 && info[2].IsNumber()) {
        rs = info[2].As<Napi::Number>().Int32Value();
    }
    if (info.Length() > 3 && info[3].IsNumber()) {
        re = info[3].As<Napi::Number>().Int32Value();
    }
    if (info.Length() > 4 && info[4].IsArray()) {
        displays = extract(info[4].As<Napi::Array>());
    }
    if (info.Length() > 5 && info[5].IsBoolean()) {
        ambiguous = info[5].As<Napi::Boolean>().Value() ? 1 : 0;
    }
    if (info.Length() > 6 && info[6].IsArray()) {
        types = extract(info[6].As<Napi::Array>());
    }

    size_t count = entries.size();
    char **c_entries = static_cast<char **>(calloc(count, sizeof(char *)));
    char **c_descs = static_cast<char **>(calloc(count, sizeof(char *)));
    char **c_displays = static_cast<char **>(calloc(count, sizeof(char *)));
    char **c_types = static_cast<char **>(calloc(count, sizeof(char *)));
    for (size_t i = 0; i < count; i++) {
        c_entries[i] = strdup(entries[i].c_str());
        c_descs[i] = (i < descs.size()) ? strdup(descs[i].c_str()) : strdup("");
        c_displays[i] = (i < displays.size()) ? strdup(displays[i].c_str()) : strdup("");
        c_types[i] = (i < types.size()) ? strdup(types[i].c_str()) : strdup("");
    }

    jinput_set_completions(g_ctx->engine, c_entries, count, c_descs, rs, re,
                           c_displays, ambiguous, c_types);

    if (g_ctx->poll) {
        uv_poll_start(g_ctx->poll, UV_READABLE, pollCallback);
    }

    return env.Undefined();
}

static Napi::Value InsertAtCursor(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        return env.Undefined();
    }
    ensure_engine();
    jinput_insert_at_cursor(g_ctx->engine, info[0].As<Napi::String>().Utf8Value().c_str());
    return env.Undefined();
}

static Napi::Value GetEAGAIN(const Napi::CallbackInfo &info) {
    return Napi::Number::New(info.Env(), EAGAIN);
}

// ---- NAPI: POSIX passthroughs that have always lived here ------------------

static Napi::Value GetpwuidName(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        return Napi::String::New(env, "");
    }
    const uid_t uid = static_cast<uid_t>(info[0].As<Napi::Number>().Int64Value());
    struct passwd pwd;
    struct passwd *result = nullptr;
    char buf[4096];
    if (getpwuid_r(uid, &pwd, buf, sizeof(buf), &result) != 0 || result == nullptr) {
        return Napi::String::New(env, "");
    }
    return Napi::String::New(env, pwd.pw_name ? pwd.pw_name : "");
}

static Napi::Value GetgrgidName(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        return Napi::String::New(env, "");
    }
    const gid_t gid = static_cast<gid_t>(info[0].As<Napi::Number>().Int64Value());
    struct group grp;
    struct group *result = nullptr;
    char buf[4096];
    if (getgrgid_r(gid, &grp, buf, sizeof(buf), &result) != 0 || result == nullptr) {
        return Napi::String::New(env, "");
    }
    return Napi::String::New(env, grp.gr_name ? grp.gr_name : "");
}

static Napi::Value HasXattr(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        return Napi::Boolean::New(env, false);
    }
    const std::string path = info[0].As<Napi::String>().Utf8Value();
#if defined(__APPLE__)
    const ssize_t n = listxattr(path.c_str(), nullptr, 0, XATTR_NOFOLLOW);
#elif defined(__linux__)
    const ssize_t n = llistxattr(path.c_str(), nullptr, 0);
#else
    const ssize_t n = -1;
#endif
    return Napi::Boolean::New(env, n > 0);
}

static Napi::Value CloseFd(const Napi::CallbackInfo &info) {
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(info.Env(), "Expected number").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    close(info[0].As<Napi::Number>().Int32Value());
    return info.Env().Undefined();
}

static Napi::Value CreatePipe(const Napi::CallbackInfo &info) {
    int fds[2];
    if (pipe(fds) != 0) {
        Napi::Error::New(info.Env(), "pipe() failed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    Napi::Array result = Napi::Array::New(info.Env(), 2);
    result.Set(static_cast<uint32_t>(0), Napi::Number::New(info.Env(), fds[0]));
    result.Set(static_cast<uint32_t>(1), Napi::Number::New(info.Env(), fds[1]));
    return result;
}

static Napi::Value DupFdUtil(const Napi::CallbackInfo &info) {
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(info.Env(), "Expected number").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    int fd = dup(info[0].As<Napi::Number>().Int32Value());
    return Napi::Number::New(info.Env(), fd);
}

static Napi::Value Dup2FdUtil(const Napi::CallbackInfo &info) {
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(info.Env(), "Expected (fd, fd)").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    int result = dup2(info[0].As<Napi::Number>().Int32Value(),
                      info[1].As<Napi::Number>().Int32Value());
    return Napi::Number::New(info.Env(), result);
}

static Napi::Value WriteFdUtil(const Napi::CallbackInfo &info) {
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
        Napi::TypeError::New(info.Env(), "Expected (fd, string)").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    int fd = info[0].As<Napi::Number>().Int32Value();
    std::string data = info[1].As<Napi::String>().Utf8Value();
    jinput_write_raw(fd, data.c_str(), data.size());
    return info.Env().Undefined();
}

// ---- Registration ----------------------------------------------------------

Napi::Object InitInputEngine(Napi::Env env, Napi::Object exports) {
    exports.Set("inputStart",              Napi::Function::New(env, InputStart));
    exports.Set("inputStop",               Napi::Function::New(env, InputStop));
    exports.Set("inputGetCols",            Napi::Function::New(env, InputGetCols));
    exports.Set("inputWriteRaw",           Napi::Function::New(env, InputWriteRaw));
    exports.Set("inputRenderLine",         Napi::Function::New(env, InputRenderLine));
    exports.Set("inputHistoryAdd",         Napi::Function::New(env, HistoryAdd));
    exports.Set("inputHistorySetMaxLen",   Napi::Function::New(env, HistorySetMaxLen));
    exports.Set("inputHistorySave",        Napi::Function::New(env, HistorySave));
    exports.Set("inputHistoryLoad",        Napi::Function::New(env, HistoryLoad));
    exports.Set("inputHistoryCount",       Napi::Function::New(env, HistoryCount));
    exports.Set("inputHistoryGet",         Napi::Function::New(env, HistoryGet));
    exports.Set("inputHistoryAll",         Napi::Function::New(env, HistoryAll));
    exports.Set("inputHistorySearchPrefix",Napi::Function::New(env, HistorySearchPrefix));
    exports.Set("inputSetSuggestion",      Napi::Function::New(env, SetSuggestion));
    exports.Set("inputSetInput",           Napi::Function::New(env, SetInput));
    exports.Set("inputInsertAtCursor",     Napi::Function::New(env, InsertAtCursor));
    exports.Set("inputSetCompletions",     Napi::Function::New(env, SetCompletions));
    exports.Set("inputSetWordChars",       Napi::Function::New(env, SetWordChars));
    exports.Set("inputSetCompletionStyle", Napi::Function::New(env, SetCompletionStyle));
    exports.Set("inputSetListColors",      Napi::Function::New(env, SetListColors));
    exports.Set("inputColorForFile",       Napi::Function::New(env, ColorForFile));
    exports.Set("getpwuidName",            Napi::Function::New(env, GetpwuidName));
    exports.Set("getgrgidName",            Napi::Function::New(env, GetgrgidName));
    exports.Set("hasXattr",                Napi::Function::New(env, HasXattr));
    exports.Set("inputEAGAIN",             Napi::Function::New(env, GetEAGAIN));
    exports.Set("closeFd",                 Napi::Function::New(env, CloseFd));
    exports.Set("createPipe",              Napi::Function::New(env, CreatePipe));
    exports.Set("dupFd",                   Napi::Function::New(env, DupFdUtil));
    exports.Set("dup2Fd",                  Napi::Function::New(env, Dup2FdUtil));
    exports.Set("writeFd",                 Napi::Function::New(env, WriteFdUtil));
    return exports;
}

} // namespace jsh
