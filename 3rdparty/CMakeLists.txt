# ---- libgrapheme (Unicode grapheme cluster support) ----
set(LIBGRAPHEME_DIR ${CMAKE_CURRENT_SOURCE_DIR}/libgrapheme)

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
target_include_directories(grapheme PUBLIC ${LIBGRAPHEME_DIR})
set_target_properties(grapheme PROPERTIES
  C_STANDARD 99
  POSITION_INDEPENDENT_CODE ON
)
# Ensure generated header exists before compiling
add_custom_target(grapheme_gen DEPENDS ${LIBGRAPHEME_DIR}/gen/character.h)
add_dependencies(grapheme grapheme_gen)

# ---- jinput (line editing library) ----
add_subdirectory(jinput)
