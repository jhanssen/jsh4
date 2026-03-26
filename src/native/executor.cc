#include "executor.h"

namespace jsh {

static Napi::Value Spawn(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    // TODO: fork/exec implementation
    return env.Undefined();
}

Napi::Object InitExecutor(Napi::Env env, Napi::Object exports) {
    exports.Set("spawn", Napi::Function::New(env, Spawn));
    return exports;
}

} // namespace jsh
