#pragma once

#include <napi.h>

namespace jsh {

Napi::Object InitExecutor(Napi::Env env, Napi::Object exports);

} // namespace jsh
