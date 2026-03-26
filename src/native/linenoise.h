#pragma once

#include <napi.h>

namespace jsh {

Napi::Object InitLinenoise(Napi::Env env, Napi::Object exports);

} // namespace jsh
