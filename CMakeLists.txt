cmake_minimum_required(VERSION 3.15)
cmake_policy(SET CMP0091 NEW)
cmake_policy(SET CMP0042 NEW)

project(jsh_native)

set(CMAKE_C_STANDARD 99)
set(CMAKE_CXX_STANDARD 17)

include_directories(${CMAKE_JS_INC})

# node-addon-api
execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
include_directories(${NODE_ADDON_API_DIR})

# ---- libgrapheme (Unicode grapheme cluster support) ----
set(LIBGRAPHEME_DIR ${CMAKE_SOURCE_DIR}/3rdparty/libgrapheme)

# Build the generator that produces gen/character.h from Unicode data files
add_executable(grapheme_gen_character
  ${LIBGRAPHEME_DIR}/gen/character.c
  ${LIBGRAPHEME_DIR}/gen/util.c
)
target_include_directories(grapheme_gen_character PRIVATE ${LIBGRAPHEME_DIR})

# Run the generator to produce gen/character.h
add_custom_command(
  OUTPUT ${LIBGRAPHEME_DIR}/gen/character.h
  COMMAND grapheme_gen_character > ${LIBGRAPHEME_DIR}/gen/character.h
  DEPENDS grapheme_gen_character
          ${LIBGRAPHEME_DIR}/data/DerivedCoreProperties.txt
          ${LIBGRAPHEME_DIR}/data/emoji-data.txt
          ${LIBGRAPHEME_DIR}/data/GraphemeBreakProperty.txt
  WORKING_DIRECTORY ${LIBGRAPHEME_DIR}
  COMMENT "Generating libgrapheme character break tables"
)

# Build libgrapheme as a static library (only the parts we need)
add_library(grapheme STATIC
  ${LIBGRAPHEME_DIR}/src/character.c
  ${LIBGRAPHEME_DIR}/src/utf8.c
  ${LIBGRAPHEME_DIR}/src/util.c
)
target_include_directories(grapheme PRIVATE ${LIBGRAPHEME_DIR})
set_target_properties(grapheme PROPERTIES
  C_STANDARD 99
  POSITION_INDEPENDENT_CODE ON
)
# Ensure generated header exists before compiling
add_custom_target(grapheme_gen DEPENDS ${LIBGRAPHEME_DIR}/gen/character.h)
add_dependencies(grapheme grapheme_gen)

# native addon sources
set(ADDON_SRC
  ${CMAKE_SOURCE_DIR}/src/native/addon.cc
  ${CMAKE_SOURCE_DIR}/src/native/executor.cc
  ${CMAKE_SOURCE_DIR}/src/native/input-engine.cc
)

add_library(${PROJECT_NAME} SHARED
  ${ADDON_SRC}
  ${CMAKE_JS_SRC}
)

set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB} grapheme)
target_include_directories(${PROJECT_NAME} PRIVATE ${LIBGRAPHEME_DIR})
target_compile_definitions(${PROJECT_NAME} PRIVATE NAPI_VERSION=8)
