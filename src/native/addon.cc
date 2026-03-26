#include <napi.h>
#include "executor.h"
#include "linenoise.h"

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    jsh::InitExecutor(env, exports);
    jsh::InitLinenoise(env, exports);
    return exports;
}

NODE_API_MODULE(jsh_native, Init)
