#include "linenoise.h"

extern "C" {
#include "linenoise.h"
}

namespace jsh {

static Napi::Value ReadLine(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    // TODO: linenoise readline binding
    return env.Undefined();
}

Napi::Object InitLinenoise(Napi::Env env, Napi::Object exports) {
    exports.Set("readLine", Napi::Function::New(env, ReadLine));
    return exports;
}

} // namespace jsh
