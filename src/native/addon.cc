#include <napi.h>
#include "executor.h"
#include "input-engine.h"

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    jsh::InitExecutor(env, exports);
    jsh::InitInputEngine(env, exports);
    return exports;
}

NODE_API_MODULE(jsh_native, Init)
