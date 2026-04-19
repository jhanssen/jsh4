#include "input-engine.h"
#include <uv.h>
#include <algorithm>
#include <cerrno>
#include <cstring>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>
#include <fcntl.h>
#include <unistd.h>
#include <termios.h>
#include <sys/ioctl.h>
#include <poll.h>

extern "C" {
#include <grapheme.h>
}

namespace jsh {

// ---- UTF-8 helpers (extracted from linenoise.c) ----------------------------

static int utf8ByteLen(unsigned char c) {
    if (c < 0x80) return 1;
    if (c < 0xE0) return 2;
    if (c < 0xF0) return 3;
    return 4;
}

static size_t utf8NextCharLen(const char *buf, size_t pos, size_t len) {
    if (pos >= len) return 1;
    return utf8ByteLen(static_cast<unsigned char>(buf[pos]));
}

static size_t utf8PrevCharLen(const char *buf, size_t pos) {
    if (pos == 0) return 0;
    size_t i = pos - 1;
    while (i > 0 && (static_cast<unsigned char>(buf[i]) & 0xC0) == 0x80) i--;
    return pos - i;
}

static uint32_t utf8DecodeChar(const char *s, size_t *clen, size_t avail = 4) {
    unsigned char c = s[0];
    if (c < 0x80) { *clen = 1; return c; }
    if (c < 0xE0) {
        *clen = 2;
        if (avail < 2) { *clen = 1; return 0xFFFD; }
        return ((c & 0x1F) << 6) | (s[1] & 0x3F);
    }
    if (c < 0xF0) {
        *clen = 3;
        if (avail < 3) { *clen = 1; return 0xFFFD; }
        return ((c & 0x0F) << 12) | ((s[1] & 0x3F) << 6) | (s[2] & 0x3F);
    }
    *clen = 4;
    if (avail < 4) { *clen = 1; return 0xFFFD; }
    return ((c & 0x07) << 18) | ((s[1] & 0x3F) << 12) | ((s[2] & 0x3F) << 6) | (s[3] & 0x3F);
}

// East Asian Width: returns 2 for wide chars, 0 for combining/control, 1 otherwise.
static int utf8CharWidth(uint32_t cp) {
    if (cp == 0) return 0;
    // Combining characters and zero-width
    if ((cp >= 0x0300 && cp <= 0x036F) ||  // Combining Diacritical Marks
        (cp >= 0x1AB0 && cp <= 0x1AFF) ||  // Combining Diacritical Marks Extended
        (cp >= 0x1DC0 && cp <= 0x1DFF) ||  // Combining Diacritical Marks Supplement
        (cp >= 0x20D0 && cp <= 0x20FF) ||  // Combining Diacritical Marks for Symbols
        (cp >= 0xFE00 && cp <= 0xFE0F) ||  // Variation Selectors
        (cp >= 0xFE20 && cp <= 0xFE2F) ||  // Combining Half Marks
        (cp >= 0xE0100 && cp <= 0xE01EF) || // Variation Selectors Supplement
        cp == 0x200B || cp == 0x200C || cp == 0x200D || cp == 0xFEFF) {
        return 0;
    }
    // Wide characters (CJK, emoji, etc.)
    if ((cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
        (cp >= 0x2E80 && cp <= 0x303E) ||   // CJK Radicals
        (cp >= 0x3040 && cp <= 0x33BF) ||   // Japanese
        (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compat Ideographs
        (cp >= 0xFE30 && cp <= 0xFE6F) ||   // CJK Compat Forms
        (cp >= 0xFF01 && cp <= 0xFF60) ||   // Fullwidth Forms
        (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // Fullwidth Signs
        (cp >= 0x20000 && cp <= 0x2FFFF) || // CJK Extension B+
        (cp >= 0x30000 && cp <= 0x3FFFF) || // CJK Extension G+
        (cp >= 0x1F000 && cp <= 0x1FFFF) || // Emoji, etc.
        (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified
        (cp >= 0x3400 && cp <= 0x4DBF)) {   // CJK Extension A
        return 2;
    }
    if (cp < 0x20) return 0; // Control chars
    return 1;
}

// ---- Grapheme cluster helpers ------------------------------------------------

// Returns the byte length of the grapheme cluster starting at buf[pos].
static size_t graphemeNextLen(const char *buf, size_t pos, size_t len) {
    if (pos >= len) return 0;
    return grapheme_next_character_break_utf8(buf + pos, len - pos);
}

// Returns the byte length of the grapheme cluster ending at buf[pos].
// Scans forward from `from` (typically line start) to find the cluster boundary.
static size_t graphemePrevLen(const char *buf, size_t pos, size_t from) {
    if (pos == 0 || pos <= from) return 0;
    size_t prev = from;
    size_t cur = from;
    while (cur < pos) {
        prev = cur;
        size_t step = grapheme_next_character_break_utf8(buf + cur, pos - cur);
        // Force forward progress: libgrapheme returning 0 inside the buffer
        // would hang the caller; treat as a single-byte cluster.
        if (step == 0) step = 1;
        cur += step;
    }
    return pos - prev;
}

// Display width of a single grapheme cluster (handles VS16 widening, ZWJ sequences, etc.)
static int graphemeClusterWidth(const char *s, size_t clen) {
    if (clen == 0) return 0;
    size_t i = 0;
    size_t blen;
    uint32_t baseCp = utf8DecodeChar(s, &blen, clen);
    int w = utf8CharWidth(baseCp);
    i += blen;
    // Check remaining codepoints in the cluster for VS16 widening
    while (i < clen) {
        uint32_t cp = utf8DecodeChar(s + i, &blen, clen - i);
        if (cp == 0xFE0F && w == 1) {
            // VS16 widens an emoji presentation base from 1 to 2 cells
            w = 2;
        }
        // Other combining/extending characters don't add width
        i += blen;
    }
    return w;
}

// Cluster-aware string width: iterates by grapheme cluster, not by codepoint.
static size_t utf8StrWidth(const char *s, size_t len) {
    size_t width = 0, i = 0;
    while (i < len) {
        size_t clen = grapheme_next_character_break_utf8(s + i, len - i);
        // Force forward progress on malformed input (see graphemePrevLen).
        if (clen == 0) clen = 1;
        width += graphemeClusterWidth(s + i, clen);
        i += clen;
    }
    return width;
}

// ANSI-aware width: skips CSI and OSC escape sequences.
static size_t utf8StrWidthAnsi(const char *s, size_t len) {
    size_t width = 0, i = 0;
    while (i < len) {
        if (i + 1 < len && (unsigned char)s[i] == 0x1b && s[i+1] == '[') {
            i += 2;
            while (i < len && (unsigned char)s[i] < 0x40) i++;
            if (i < len) i++;
            continue;
        }
        if (i + 1 < len && (unsigned char)s[i] == 0x1b && s[i+1] == ']') {
            i += 2;
            while (i < len) {
                if ((unsigned char)s[i] == 0x07) { i++; break; }
                if ((unsigned char)s[i] == 0x1b && i + 1 < len && s[i+1] == '\\') { i += 2; break; }
                i++;
            }
            continue;
        }
        size_t clen = grapheme_next_character_break_utf8(s + i, len - i);
        width += graphemeClusterWidth(s + i, clen);
        i += clen;
    }
    return width;
}

// ---- Raw mode --------------------------------------------------------------

static struct termios orig_termios;
static int rawmode = 0;

static int enableRawMode(int fd) {
    struct termios raw;
    if (!isatty(fd) && !getenv("LINENOISE_ASSUME_TTY")) return -1;
    if (tcgetattr(fd, &orig_termios) == -1) return -1;
    raw = orig_termios;
    raw.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
    raw.c_oflag &= ~(OPOST);
    raw.c_cflag |= (CS8);
    raw.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
    raw.c_cc[VMIN] = 1;
    raw.c_cc[VTIME] = 0;
    if (tcsetattr(fd, TCSAFLUSH, &raw) < 0) return -1;
    rawmode = 1;
    // Enable bracketed paste (DECSET 2004). Write to stdout (not the input
    // fd, which may be O_RDONLY). Safe on terminals that don't support it —
    // they ignore unknown private-mode sequences.
    (void)!write(STDOUT_FILENO, "\x1b[?2004h", 8);
    return 0;
}

// Ensure fd is in blocking mode. Node / libuv can leave stdin in O_NONBLOCK,
// which breaks interactive children (they see EAGAIN from their read() loops
// and bail) and the `read` builtin (readSync throws EAGAIN on empty stdin).
static void ensureBlocking(int fd) {
    int fl = fcntl(fd, F_GETFL);
    if (fl != -1 && (fl & O_NONBLOCK)) {
        fcntl(fd, F_SETFL, fl & ~O_NONBLOCK);
    }
}

static void disableRawMode(int fd) {
    if (rawmode) {
        (void)!write(STDOUT_FILENO, "\x1b[?2004l", 8);
        tcsetattr(fd, TCSAFLUSH, &orig_termios);
        ensureBlocking(fd);
        rawmode = 0;
    }
}

// ---- History ---------------------------------------------------------------

static char **history = nullptr;
static int history_len = 0;
static int history_max_len = 100;

int historyAdd(const char *line) {
    if (history_max_len == 0) return 0;
    if (!history) {
        history = (char **)calloc(history_max_len, sizeof(char*));
        if (!history) return 0;
    }
    // Don't add duplicates
    if (history_len > 0 && !strcmp(history[history_len-1], line)) return 0;
    char *copy = strdup(line);
    if (!copy) return 0;
    if (history_len == history_max_len) {
        free(history[0]);
        memmove(history, history+1, sizeof(char*)*(history_max_len-1));
        history_len--;
    }
    history[history_len++] = copy;
    return 1;
}

int historySetMaxLen(int len) {
    if (len < 1) return 0;
    if (history) {
        int tocopy = history_len;
        char **newh = (char **)calloc(len, sizeof(char*));
        if (!newh) return 0;
        if (tocopy > len) {
            for (int j = 0; j < tocopy - len; j++) free(history[j]);
            tocopy = len;
        }
        memcpy(newh, history + (history_len - tocopy), sizeof(char*) * tocopy);
        free(history);
        history = newh;
        history_len = tocopy;
    }
    history_max_len = len;
    return 1;
}

int historySave(const char *filename) {
    FILE *fp = fopen(filename, "w");
    if (!fp) return -1;
    for (int j = 0; j < history_len; j++) {
        const char *entry = history[j];
        // Multi-line entries: write each line with trailing backslash for continuation.
        const char *p = entry;
        while (*p) {
            const char *nl = strchr(p, '\n');
            if (nl) {
                fwrite(p, 1, nl - p, fp);
                fputs("\\\n", fp); // trailing \ indicates continuation
                p = nl + 1;
            } else {
                fputs(p, fp);
                fputc('\n', fp);
                break;
            }
        }
        if (entry[0] == '\0' || (strlen(entry) > 0 && entry[strlen(entry)-1] == '\n')) {
            fputc('\n', fp);
        }
    }
    fclose(fp);
    return 0;
}

int historyLoad(const char *filename) {
    FILE *fp = fopen(filename, "r");
    if (!fp) return -1;
    char buf[4096];
    std::string entry;
    bool continuation = false;
    while (fgets(buf, sizeof(buf), fp)) {
        // Strip trailing \n and \r.
        size_t len = strlen(buf);
        while (len > 0 && (buf[len-1] == '\n' || buf[len-1] == '\r')) len--;
        buf[len] = '\0';
        // Check for continuation (trailing backslash).
        if (len > 0 && buf[len-1] == '\\') {
            buf[len-1] = '\0';
            if (continuation) entry += '\n';
            entry += buf;
            continuation = true;
        } else {
            if (continuation) {
                entry += '\n';
                entry += buf;
                historyAdd(entry.c_str());
                entry.clear();
                continuation = false;
            } else {
                historyAdd(buf);
            }
        }
    }
    // Flush any trailing continuation.
    if (continuation && !entry.empty()) {
        historyAdd(entry.c_str());
    }
    fclose(fp);
    return 0;
}

// ---- Input state -----------------------------------------------------------

#define INPUT_BUF_SIZE 4096

struct InputState {
    int ifd = STDIN_FILENO;
    int ofd = STDOUT_FILENO;
    char buf[INPUT_BUF_SIZE];
    size_t buflen = INPUT_BUF_SIZE - 1;
    size_t pos = 0;
    size_t len = 0;
    int history_index = 0;
    bool active = false;
    int in_completion = 0;
    size_t completion_idx = 0;
    bool waiting_for_completions = false;
    // Cached completion state: original buffer + candidates from first Tab.
    // The splice replaces buf[completion_start..completion_end] with the
    // chosen entry; text outside that range is preserved. For backward-compat
    // with the legacy string[] return, replaceStart/replaceEnd default to
    // [0, word_end] so entries are treated as full-prefix replacements.
    std::string completion_original; // buffer before first completion applied
    size_t completion_start = 0;
    size_t completion_end = 0;
    std::string completion_pre;      // buf[0..completion_start], preserved
    std::string completion_tail;     // buf[completion_end..], preserved
    std::vector<std::string> completion_entries; // spliced into buf on accept
    // Parallel to completion_entries. `completion_displays` is what the menu
    // grid shows for each entry — typically the basename when entries share a
    // directory prefix. Empty string = render the entry text itself.
    std::vector<std::string> completion_descriptions;
    std::vector<std::string> completion_displays;
    // Type hint for LS_COLORS colorization in the menu grid. Values are the
    // short names "file" / "dir" / "exec" / "link" or "" for no-color.
    std::vector<std::string> completion_types;
    // Menu-complete mode (zsh's `menu-select` behavior; opt-in via
    // jsh.setCompletionStyle("menu")). State machine:
    //   0 = inactive
    //   1 = grid shown (first Tab surfaced candidates; no selection, buffer
    //       unchanged)
    //   2 = navigating (second Tab advanced to selection; buffer tentatively
    //       holds the current match and is restored on Esc)
    int menu_state = 0;
    int menu_rows = 0;
    int menu_cols = 0;
    int menu_row = 0;           // selected cell (row)
    int menu_col = 0;           // selected cell (col)
    int menu_viewport_start = 0;
    int menu_col_width = 0;     // uniform column width (longest entry + gap)
    int menu_viewport_max = 10; // max rows rendered at once
    size_t menu_display_prefix_len = 0; // byte-LCP across entries stripped for display
    std::string menu_orig_buf;  // buffer to restore on Esc from state 2
    size_t menu_orig_pos = 0;
    size_t menu_orig_len = 0;
    // Reverse search (Ctrl-R)
    bool in_search = false;
    char search_query[256];
    size_t search_query_len = 0;
    // search_match_index: -1 = no match yet, -2 = match inside the pre-search
    // buffer (orig_buf), 0+ = history index.
    int search_match_index = -1;
    // Snapshot of the buffer + cursor position at the moment search started,
    // so we can (a) include the live buffer as an implicit search candidate
    // and (b) restore it when the user steps back from a history match.
    char orig_buf[INPUT_BUF_SIZE];
    size_t orig_pos = 0;
    size_t orig_len = 0;
    // Suggestion (fish-style ghost text)
    std::string suggestion;        // the full suggested line
    uint32_t suggestion_id = 0;    // monotonic ID — incremented on each buffer change
    // Inline forward search (Ctrl-S)
    bool in_line_search = false;
    char line_search_query[256];
    size_t line_search_query_len = 0;
    size_t line_search_start = 0;      // search from this position forward
    size_t line_search_orig_pos = 0;   // cursor position at search entry
    // Pending Esc: we've read an Esc byte but no follow-up was in the kernel
    // buffer yet. The next byte (whenever it arrives — could be ms later for a
    // split CSI burst, or seconds later for user-typed Esc-then-B) is
    // dispatched as the second byte of an Esc-prefixed sequence.
    bool esc_pending = false;
    // Bracketed paste (DECSET 2004). Terminal wraps pasted content in
    // ESC[200~ ... ESC[201~. While in_paste is true, bytes accumulate in
    // paste_buf; the end marker is matched one byte at a time against
    // "[201~" via paste_marker_state (0 = no partial match, 1 = saw ESC,
    // 2..5 = matched "[201" prefix).
    bool in_paste = false;
    std::string paste_buf;
    int paste_marker_state = 0;
    // Kill ring (zsh KRINGCTDEF = 8). `cut_buf` is the current accumulator;
    // a non-kill action between kills pushes the old cut_buf onto the ring
    // and starts a new accumulator on the next kill. `last_was_kill` snapshot
    // at the top of editFeed drives the accumulate-vs-new-entry decision.
    // Yank inserts cut_buf; yank-pop replaces the [yank_start, yank_end)
    // range with older ring entries, rotating.
    std::string cut_buf;
    std::vector<std::string> kill_ring;
    size_t kill_ring_head = 0;
    bool last_was_kill = false;
    bool last_was_yank = false;
    size_t yank_start = 0;
    size_t yank_end = 0;
    // yank_pop_idx: -1 = cut_buf, 0+ = kill_ring offset back from head.
    int yank_pop_idx = -1;
    // Prefix history search (Up/Down / Ctrl-P/Ctrl-N — zsh's
    // up-line-or-beginning-search). Live across consecutive Up/Down presses;
    // cleared whenever any other key fires.
    bool in_prefix_search = false;
    char prefix_anchor[INPUT_BUF_SIZE];     // buffer[0..cursor] at first Up
    size_t prefix_anchor_len = 0;
    size_t prefix_cursor = 0;               // cursor byte offset to restore
    int prefix_index = -1;                  // history index of current match
    char prefix_orig_buf[INPUT_BUF_SIZE];   // for restore on Down-past-newest
    size_t prefix_orig_len = 0;
    size_t prefix_orig_pos = 0;
};

static InputState g_state;

// ---- Buffer editing operations ---------------------------------------------

// Forward declarations — defined later in this file.
static void bufferChanged();
static void notifyRender();
static inline int finalizedCount();
static std::optional<std::string> readEscPayload(int fd, char introducer);
static void deliverEscResponse(char introducer, const std::string& payload);
static void prefixSearchStart(InputState *s);
static bool prefixSearchOlder(InputState *s);
static bool prefixSearchNewer(InputState *s);
static void historyUpOrPrefixSearch(InputState *s, bool was_in_prefix_search);
static void historyDownOrPrefixSearch(InputState *s, bool was_in_prefix_search);
static int dispatchEscPrefix(InputState *s, char first, bool was_in_prefix_search,
                             bool was_kill, bool was_yank);
static void menuNavigate(InputState *s, int dr, int dc);
static void menuClose(InputState *s, bool restore);
static std::vector<std::string> menuRenderLines(InputState *s);
static size_t lineStart(const char *buf, size_t pos);

static void editInsert(InputState *s, const char *c, size_t clen) {
    if (s->len + clen > s->buflen) return;
    if (s->len == s->pos) {
        memcpy(s->buf + s->pos, c, clen);
    } else {
        memmove(s->buf + s->pos + clen, s->buf + s->pos, s->len - s->pos);
        memcpy(s->buf + s->pos, c, clen);
    }
    s->pos += clen;
    s->len += clen;
    s->buf[s->len] = '\0';
    bufferChanged();
}

static void editDelete(InputState *s) {
    if (s->len > 0 && s->pos < s->len) {
        size_t clen = graphemeNextLen(s->buf, s->pos, s->len);
        if (clen == 0) return;
        memmove(s->buf + s->pos, s->buf + s->pos + clen, s->len - s->pos - clen);
        s->len -= clen;
        s->buf[s->len] = '\0';
        bufferChanged();
    }
}

static void editBackspace(InputState *s) {
    if (s->pos > 0 && s->len > 0) {
        size_t from = lineStart(s->buf, s->pos);
        size_t clen = graphemePrevLen(s->buf, s->pos, from);
        if (clen == 0) return;
        memmove(s->buf + s->pos - clen, s->buf + s->pos, s->len - s->pos);
        s->pos -= clen;
        s->len -= clen;
        s->buf[s->len] = '\0';
        bufferChanged();
    }
}

static void editMoveLeft(InputState *s) {
    if (s->pos > 0) {
        size_t from = lineStart(s->buf, s->pos);
        s->pos -= graphemePrevLen(s->buf, s->pos, from);
    }
}

static void editMoveRight(InputState *s) {
    if (s->pos < s->len) {
        s->pos += graphemeNextLen(s->buf, s->pos, s->len);
    }
}

// Find the start of the line containing pos.
static size_t lineStart(const char *buf, size_t pos) {
    if (pos == 0) return 0;
    size_t i = pos - 1;
    while (i > 0 && buf[i] != '\n') i--;
    return buf[i] == '\n' ? i + 1 : 0;
}

// Find the end of the line containing pos (position of \n or len).
static size_t lineEnd(const char *buf, size_t pos, size_t len) {
    size_t i = pos;
    while (i < len && buf[i] != '\n') i++;
    return i;
}

static void editMoveHome(InputState *s) {
    s->pos = lineStart(s->buf, s->pos);
}

static void editMoveEnd(InputState *s) {
    s->pos = lineEnd(s->buf, s->pos, s->len);
}

// Move cursor up one line. Returns true if moved, false if already on first line.
static bool editMoveUp(InputState *s) {
    size_t curLineStart = lineStart(s->buf, s->pos);
    if (curLineStart == 0) return false; // Already on first line.
    // Column position within current line.
    size_t col = utf8StrWidth(s->buf + curLineStart, s->pos - curLineStart);
    // Move to previous line.
    size_t prevLineEnd = curLineStart - 1; // the \n
    size_t prevLineStart = lineStart(s->buf, prevLineEnd);
    // Find position at same column in previous line.
    size_t i = prevLineStart;
    size_t w = 0;
    while (i < prevLineEnd) {
        size_t clen = graphemeNextLen(s->buf, i, prevLineEnd);
        if (clen == 0) break;
        int cw = graphemeClusterWidth(s->buf + i, clen);
        if (w + cw > col) break;
        w += cw;
        i += clen;
    }
    s->pos = i;
    return true;
}

// Move cursor down one line. Returns true if moved, false if already on last line.
static bool editMoveDown(InputState *s) {
    size_t curLineStart = lineStart(s->buf, s->pos);
    size_t curLineEnd = lineEnd(s->buf, s->pos, s->len);
    if (curLineEnd >= s->len) return false; // Already on last line.
    // Column position within current line.
    size_t col = utf8StrWidth(s->buf + curLineStart, s->pos - curLineStart);
    // Move to next line.
    size_t nextLineStart = curLineEnd + 1; // skip the \n
    size_t nextLineEnd = lineEnd(s->buf, nextLineStart, s->len);
    // Find position at same column in next line.
    size_t i = nextLineStart;
    size_t w = 0;
    while (i < nextLineEnd) {
        size_t clen = graphemeNextLen(s->buf, i, nextLineEnd);
        if (clen == 0) break;
        int cw = graphemeClusterWidth(s->buf + i, clen);
        if (w + cw > col) break;
        w += cw;
        i += clen;
    }
    s->pos = i;
    return true;
}

// Word-boundary predicate for Alt-B / Alt-F / Alt-D / Alt-Backspace / Ctrl-W.
// A cluster is a word char if: non-ASCII (treats CJK, accented latin, emoji
// as word-interior), ASCII alnum, or ASCII punctuation listed in `wordchars`
// (zsh's WORDCHARS — settable via jsh.setWordChars). Defaults to zsh's
// DEFAULT_WORDCHARS = *?_-.[]~=/&;!#$%^(){}<>, so `-foo`, `path/to/file`,
// `VAR=val` are each a single word.
static std::string wordchars = "*?_-.[]~=/&;!#$%^(){}<>";

// Menu-complete opt-in. Set via jsh.setCompletionStyle("menu" | "cycle").
// Default is "cycle" (current behavior — Tab cycles through candidates).
static bool g_menu_complete = false;

// ---- LS_COLORS (GNU format) -----------------------------------------------
//
// Populated via jsh.setListColors(str). Used by menuRenderLines to colorize
// grid cells. Format: colon-separated "key=SGR" entries where key is either
// a two-letter type code (di, ln, ex, fi, ...) or a glob-ish "*.ext".
static std::unordered_map<std::string, std::string> g_lscolors_types;
static std::vector<std::pair<std::string, std::string>> g_lscolors_exts; // {".ext", "01;31"}

static void parseLsColors(const std::string &s) {
    g_lscolors_types.clear();
    g_lscolors_exts.clear();
    size_t i = 0;
    while (i < s.size()) {
        size_t end = s.find(':', i);
        if (end == std::string::npos) end = s.size();
        size_t eq = s.find('=', i);
        if (eq != std::string::npos && eq < end) {
            std::string key(s, i, eq - i);
            std::string val(s, eq + 1, end - eq - 1);
            if (!val.empty()) {
                if (!key.empty() && key[0] == '*') {
                    // Glob-ish extension rule ("*.tar", "*.png"). Store the
                    // suffix starting from the '.' for simple endsWith().
                    g_lscolors_exts.emplace_back(key.substr(1), std::move(val));
                } else {
                    g_lscolors_types.emplace(std::move(key), std::move(val));
                }
            }
        }
        i = (end < s.size()) ? end + 1 : end;
    }
}

// Returns the SGR parameter string ("01;34") for an entry, or "" if no rule
// applies. `type_hint` is one of "file" / "dir" / "exec" / "link" / "" from
// the TS side; `display` is the user-visible cell text (used for *.ext match).
static const std::string *lookupLsColor(const std::string &type_hint,
                                        const std::string &display) {
    const char *key = nullptr;
    if      (type_hint == "dir")  key = "di";
    else if (type_hint == "exec") key = "ex";
    else if (type_hint == "link") key = "ln";
    else if (type_hint == "file") {
        // Try *.ext first — more specific than generic "fi".
        for (const auto &pr : g_lscolors_exts) {
            if (display.size() >= pr.first.size() &&
                display.compare(display.size() - pr.first.size(),
                                pr.first.size(), pr.first) == 0) {
                return &pr.second;
            }
        }
        key = "fi";
    }
    if (!key) return nullptr;
    auto it = g_lscolors_types.find(key);
    return it == g_lscolors_types.end() ? nullptr : &it->second;
}

static bool isWordCluster(const char *buf, size_t pos, size_t clen) {
    if (clen == 0) return false;
    unsigned char c = static_cast<unsigned char>(buf[pos]);
    if (c >= 0x80) return true;
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return true;
    return wordchars.find(static_cast<char>(c)) != std::string::npos;
}

static void editMoveWordRight(InputState *s) {
    // Skip non-word clusters, then skip word clusters — standard emacs M-f.
    while (s->pos < s->len) {
        size_t clen = graphemeNextLen(s->buf, s->pos, s->len);
        if (clen == 0) break;
        if (isWordCluster(s->buf, s->pos, clen)) break;
        s->pos += clen;
    }
    while (s->pos < s->len) {
        size_t clen = graphemeNextLen(s->buf, s->pos, s->len);
        if (clen == 0) break;
        if (!isWordCluster(s->buf, s->pos, clen)) break;
        s->pos += clen;
    }
}

static void editMoveWordLeft(InputState *s) {
    // Mirror: skip non-word clusters backward, then skip word clusters backward.
    // Bounded scan from line start keeps graphemePrevLen's forward walk O(line).
    size_t line_begin = lineStart(s->buf, s->pos);
    while (s->pos > line_begin) {
        size_t clen = graphemePrevLen(s->buf, s->pos, line_begin);
        if (clen == 0) break;
        if (isWordCluster(s->buf, s->pos - clen, clen)) break;
        s->pos -= clen;
    }
    while (s->pos > line_begin) {
        size_t clen = graphemePrevLen(s->buf, s->pos, line_begin);
        if (clen == 0) break;
        if (!isWordCluster(s->buf, s->pos - clen, clen)) break;
        s->pos -= clen;
    }
}

// ---- Kill ring (zsh-compatible) -------------------------------------------

static constexpr size_t KILL_RING_MAX = 8;

// Save `text` to the kill ring. `was_kill` = last action was also a kill
// (coalesce into cut_buf); `front` = text came from before the cursor
// (prepend to cut_buf so original order is preserved for yank).
static void killSave(InputState *s, const char *text, size_t len, bool was_kill, bool front) {
    if (len == 0) return;
    if (!was_kill) {
        // Non-kill action broke the streak — push old cut_buf to ring, start
        // a new accumulator.
        if (!s->cut_buf.empty()) {
            if (s->kill_ring.size() < KILL_RING_MAX) {
                s->kill_ring.push_back(std::move(s->cut_buf));
                s->kill_ring_head = s->kill_ring.size() - 1;
            } else {
                s->kill_ring_head = (s->kill_ring_head + 1) % KILL_RING_MAX;
                s->kill_ring[s->kill_ring_head] = std::move(s->cut_buf);
            }
        }
        s->cut_buf.clear();
    }
    if (front) {
        s->cut_buf.insert(0, text, len);
    } else {
        s->cut_buf.append(text, len);
    }
}

static void yank(InputState *s) {
    if (s->cut_buf.empty() && s->kill_ring.empty()) return;
    const std::string *src = &s->cut_buf;
    if (src->empty() && !s->kill_ring.empty()) {
        src = &s->kill_ring[s->kill_ring_head];
    }
    if (s->len + src->size() > s->buflen) return;
    s->yank_start = s->pos;
    editInsert(s, src->data(), src->size());
    s->yank_end = s->pos;
    s->last_was_yank = true;
    s->yank_pop_idx = -1;
}

static void yankPop(InputState *s, bool was_yank) {
    if (!was_yank) return; // only valid immediately after yank / yank-pop
    if (s->kill_ring.empty()) return;
    // Advance to next-older entry. -1 means we're sitting on cut_buf; move
    // to ring[head], then ring[head-1], wrapping through the ring size.
    s->yank_pop_idx = (s->yank_pop_idx + 1) % static_cast<int>(s->kill_ring.size());
    int idx = (static_cast<int>(s->kill_ring_head) -
               s->yank_pop_idx + static_cast<int>(s->kill_ring.size())) %
              static_cast<int>(s->kill_ring.size());
    const std::string &next = s->kill_ring[idx];

    // Replace [yank_start, yank_end) with `next`.
    size_t cur_len = s->yank_end - s->yank_start;
    if (s->len - cur_len + next.size() > s->buflen) return;
    memmove(s->buf + s->yank_start + next.size(),
            s->buf + s->yank_end, s->len - s->yank_end);
    memcpy(s->buf + s->yank_start, next.data(), next.size());
    s->len = s->len - cur_len + next.size();
    s->buf[s->len] = '\0';
    s->pos = s->yank_start + next.size();
    s->yank_end = s->pos;
    s->last_was_yank = true;
    bufferChanged();
}

// Common path for all kill operations: save [start, end) to the kill ring,
// splice it out of the buffer, park the cursor at `start`, and mark the
// last action as a kill so the next consecutive kill coalesces.
static void doKill(InputState *s, size_t start, size_t end, bool was_kill, bool front) {
    if (end <= start) return;
    killSave(s, s->buf + start, end - start, was_kill, front);
    memmove(s->buf + start, s->buf + end, s->len - end);
    s->len -= (end - start);
    s->buf[s->len] = '\0';
    s->pos = start;
    s->last_was_kill = true;
    bufferChanged();
}

static void editKillWordRight(InputState *s, bool was_kill) {
    size_t start = s->pos;
    editMoveWordRight(s);
    size_t end = s->pos;
    s->pos = start;
    doKill(s, start, end, was_kill, /*front=*/false);
}

static void editKillWordLeft(InputState *s, bool was_kill) {
    size_t end = s->pos;
    editMoveWordLeft(s);
    doKill(s, s->pos, end, was_kill, /*front=*/true);
}

static void editHistoryNav(InputState *s, int dir) {
    // dir: 1 = prev (older), -1 = next (newer)
    if (history_len <= 1) return;
    // Save current line to history
    free(history[history_len - 1 - s->history_index]);
    history[history_len - 1 - s->history_index] = strdup(s->buf);
    s->history_index += dir;
    if (s->history_index < 0) { s->history_index = 0; return; }
    if (s->history_index >= history_len) { s->history_index = history_len - 1; return; }
    strncpy(s->buf, history[history_len - 1 - s->history_index], s->buflen);
    s->buf[s->buflen] = '\0';
    s->len = s->pos = strlen(s->buf);
    bufferChanged();
}

// ---- Control key constants -------------------------------------------------

// ---- Reverse history search ------------------------------------------------

static void searchHistoryReverse(InputState *s, bool nextMatch = false) {
    if (s->search_query_len == 0) {
        // Empty query — restore the original buffer so backspacing all the way
        // back reverts any history match that had been shown.
        s->search_match_index = -1;
        memcpy(s->buf, s->orig_buf, s->orig_len);
        s->buf[s->orig_len] = '\0';
        s->len = s->orig_len;
        s->pos = s->orig_pos;
        return;
    }

    // First try the pre-search buffer. The live text participates as an
    // implicit candidate, but we only accept a match whose start position is
    // at or before the cursor — matches that would require advancing the
    // cursor forward fall through to the normal history search instead.
    // nextMatch skips this step (Ctrl-R advances past the buffer match).
    if (!nextMatch && s->search_match_index == -1 && s->orig_len > 0) {
        const char *hay = s->orig_buf;
        const char *found = strstr(hay, s->search_query);
        if (found != nullptr && (size_t)(found - hay) <= s->orig_pos) {
            s->search_match_index = -2;
            memcpy(s->buf, s->orig_buf, s->orig_len);
            s->buf[s->orig_len] = '\0';
            s->len = s->orig_len;
            s->pos = (size_t)(found - hay);
            return;
        }
    }

    // History search. Starts from current match (nextMatch=false) or the one
    // before it (nextMatch=true). A buffer match (-2) advancing via Ctrl-R
    // starts history from the end.
    int start;
    if (s->search_match_index >= 0) {
        start = nextMatch ? s->search_match_index - 1 : s->search_match_index;
    } else {
        start = history_len - 2; // -2 skips the current editing temp entry
    }
    for (int i = start; i >= 0; i--) {
        const char *match = strstr(history[i], s->search_query);
        if (match != nullptr) {
            s->search_match_index = i;
            strncpy(s->buf, history[i], s->buflen);
            s->buf[s->buflen] = '\0';
            s->len = strlen(s->buf);
            // Cursor lands at the start of the matched substring so arrow
            // keys step through the match rather than past the end of the line.
            s->pos = (size_t)(match - history[i]);
            return;
        }
    }
    // No match found — keep current state.
}

static void enterSearchMode(InputState *s) {
    s->in_search = true;
    s->search_query[0] = '\0';
    s->search_query_len = 0;
    s->search_match_index = -1;
    // Snapshot the buffer + cursor so the live text can participate in the
    // search and so exiting search can restore it.
    memcpy(s->orig_buf, s->buf, s->len);
    s->orig_buf[s->len] = '\0';
    s->orig_len = s->len;
    s->orig_pos = s->pos;
}

static void exitSearchMode(InputState *s) {
    s->in_search = false;
    s->search_query_len = 0;
}

// ---- Inline forward search (Ctrl-S) ----------------------------------------

static void lineSearchForward(InputState *s) {
    if (s->line_search_query_len == 0) {
        // Empty query — put the cursor back where it was when search started,
        // so backspacing through the query reverts every cursor advance.
        s->pos = s->line_search_orig_pos;
        s->line_search_start = s->line_search_orig_pos;
        return;
    }
    // Search forward from line_search_start.
    const char *haystack = s->buf + s->line_search_start;
    size_t remaining = s->len - s->line_search_start;
    const char *found = static_cast<const char *>(
        memmem(haystack, remaining, s->line_search_query, s->line_search_query_len));
    if (found) {
        // Cursor at end of match (zsh behavior — cursor advances with each typed char).
        s->pos = (found - s->buf) + s->line_search_query_len;
        s->line_search_start = (found - s->buf) + 1; // next Ctrl-S starts after this match
    }
}

// Dispatch an Esc-prefixed input byte. `first` is the byte immediately
// following Esc — either the only byte of a Meta-char sequence (Alt-B etc.),
// the DCS/OSC introducer (P/]), or the CSI/SS3 introducer ([ or O). Returns 0
// for "consumed; need more input" / 1 for line accepted. Currently no bindings
// produce a line, so always returns 0.
static int dispatchEscPrefix(InputState *s, char first, bool was_in_prefix_search,
                             bool was_kill, bool was_yank) {
    char seq[3];
    seq[0] = first;

    // DCS (ESC P ... ST) and OSC (ESC ] ... ST|BEL) responses — collect
    // payload and dispatch to JS instead of treating as keystrokes.
    if (seq[0] == 'P' || seq[0] == ']') {
        auto payload = readEscPayload(s->ifd, seq[0]);
        if (payload.has_value()) deliverEscResponse(seq[0], *payload);
        return 0;
    }

    // Meta/Alt single-char sequences (ESC + c).
    if (seq[0] == 'b') { editMoveWordLeft(s); notifyRender(); return 0; }
    if (seq[0] == 'f') { editMoveWordRight(s); notifyRender(); return 0; }
    if (seq[0] == 'd') { editKillWordRight(s, was_kill); notifyRender(); return 0; }
    if (seq[0] == 0x7F || seq[0] == 0x08) { editKillWordLeft(s, was_kill); notifyRender(); return 0; }
    if (seq[0] == 'y') { yankPop(s, was_yank); notifyRender(); return 0; }

    // CSI (ESC [) and SS3 (ESC O) — need further bytes. These always arrive
    // as a burst so the blocking read suffices (libuv's kernel buffer already
    // holds them when the first byte became readable).
    if (seq[0] != '[' && seq[0] != 'O') return 0;
    if (read(s->ifd, seq+1, 1) == -1) return 0;

    if (seq[0] == '[') {
        if (seq[1] >= '0' && seq[1] <= '9') {
            // Multi-digit parameter, terminated by '~' (or abandoned on any
            // unexpected byte). Collect digits into `params` then dispatch.
            char params[16];
            params[0] = seq[1];
            size_t n = 1;
            while (n < sizeof(params) - 1) {
                char ch;
                if (read(s->ifd, &ch, 1) != 1) break;
                if (ch == '~') {
                    params[n] = '\0';
                    if (strcmp(params, "3") == 0) { editDelete(s); notifyRender(); }
                    else if (strcmp(params, "200") == 0) {
                        // Bracketed paste begins. Subsequent bytes go through
                        // processPasteByte until ESC[201~ ends the paste.
                        s->in_paste = true;
                        s->paste_buf.clear();
                        s->paste_marker_state = 0;
                    }
                    // ESC[201~ outside paste mode is ignored — the end marker
                    // is only meaningful in paste mode, where it's matched
                    // one byte at a time inside processPasteByte.
                    break;
                }
                if (ch < '0' || ch > '9') break;
                params[n++] = ch;
            }
        } else {
            // Menu-complete navigation takes over the arrows in state 2.
            // State 1 (grid shown, no selection) falls through to normal
            // arrow behavior — the user is still editing the input line.
            if (s->menu_state == 2) {
                switch (seq[1]) {
                case 'A': menuNavigate(s, -1, 0); notifyRender(); return 0;
                case 'B': menuNavigate(s, +1, 0); notifyRender(); return 0;
                case 'C': menuNavigate(s, 0, +1); notifyRender(); return 0;
                case 'D': menuNavigate(s, 0, -1); notifyRender(); return 0;
                }
            }
            switch (seq[1]) {
            case 'A':
                historyUpOrPrefixSearch(s, was_in_prefix_search);
                notifyRender();
                break;
            case 'B':
                historyDownOrPrefixSearch(s, was_in_prefix_search);
                notifyRender();
                break;
            case 'C': // Right
                if (s->pos == s->len && !s->suggestion.empty() &&
                    s->suggestion.size() > s->len &&
                    s->suggestion.compare(0, s->len, s->buf, s->len) == 0) {
                    size_t slen = s->suggestion.size();
                    if (slen <= s->buflen) {
                        memcpy(s->buf, s->suggestion.c_str(), slen);
                        s->buf[slen] = '\0';
                        s->pos = s->len = slen;
                        bufferChanged();
                    }
                } else {
                    editMoveRight(s);
                }
                notifyRender();
                break;
            case 'D': editMoveLeft(s); notifyRender(); break;
            case 'H': editMoveHome(s); notifyRender(); break;
            case 'F': editMoveEnd(s); notifyRender(); break;
            }
        }
    } else if (seq[0] == 'O') {
        switch (seq[1]) {
        case 'H': editMoveHome(s); notifyRender(); break;
        case 'F': editMoveEnd(s); notifyRender(); break;
        }
    }
    return 0;
}

// Unified Up/Down-in-buffer-or-history dispatch used by arrow keys and
// Ctrl-P/Ctrl-N. `was_in_prefix_search` is the flag as observed at the top of
// editFeed (before the per-call reset); on entry to prefix search we capture
// the anchor, on subsequent Up/Down we walk the match list.
static void historyUpOrPrefixSearch(InputState *s, bool was_in_prefix_search) {
    if (editMoveUp(s)) return;
    if (was_in_prefix_search) {
        prefixSearchOlder(s);
        s->in_prefix_search = true;
        return;
    }
    // Already mid plain-history-walk (history_index > 0) — keep walking plain
    // history rather than re-deciding based on the just-loaded buffer. Without
    // this, Up into "vi" would cause the *next* Up to enter prefix-search mode
    // on "vi" as the anchor.
    if (s->history_index > 0) {
        editHistoryNav(s, 1);
        return;
    }
    if (s->pos > 0) {
        prefixSearchStart(s);
        if (prefixSearchOlder(s)) {
            s->in_prefix_search = true;
            return;
        }
        // No match: leave the buffer untouched and don't engage prefix search
        // so a second Up falls back to plain history nav like the old behavior.
        return;
    }
    // Empty prefix — fall through to plain history nav (older).
    editHistoryNav(s, 1);
}

static void historyDownOrPrefixSearch(InputState *s, bool was_in_prefix_search) {
    if (editMoveDown(s)) return;
    if (was_in_prefix_search) {
        prefixSearchNewer(s);
        // prefixSearchNewer clears in_prefix_search on overshoot; otherwise
        // keep the streak alive.
        if (s->len != s->prefix_orig_len ||
            memcmp(s->buf, s->prefix_orig_buf, s->len) != 0) {
            s->in_prefix_search = true;
        }
        return;
    }
    // Plain history nav (Down is a no-op at the bottom; editHistoryNav clamps).
    editHistoryNav(s, -1);
}

static void enterLineSearch(InputState *s) {
    s->in_line_search = true;
    s->line_search_query[0] = '\0';
    s->line_search_query_len = 0;
    s->line_search_start = s->pos; // start searching from current cursor
    s->line_search_orig_pos = s->pos;
}

// ---- Bracketed paste (DECSET 2004) -----------------------------------------

// Partial end-marker bytes matched so far get flushed to the paste buffer as
// literal content when a mismatch interrupts the match.
static void flushPasteMarker(InputState *s) {
    static const char partial[] = "\x1b[201~";
    for (int i = 0; i < s->paste_marker_state; i++) {
        s->paste_buf.push_back(partial[i]);
    }
    s->paste_marker_state = 0;
}

static void commitPaste(InputState *s) {
    if (!s->paste_buf.empty()) {
        // editInsert itself caps at buflen, so oversized pastes truncate
        // cleanly. Newlines pass through as literal bytes — the TS renderer
        // already handles multi-line buffers (history recall of `\`-continued
        // entries exercises the same path).
        editInsert(s, s->paste_buf.data(), s->paste_buf.size());
    }
    s->paste_buf.clear();
}

// Feed one byte into the paste reader. Either extends the partial end-marker
// match, flushes a broken partial match + re-processes the byte, or appends
// plain content.
static void processPasteByte(InputState *s, char c) {
    static const char expected[] = "\x1b[201~";
    static const int expected_len = 6;
    if (s->paste_marker_state < expected_len && c == expected[s->paste_marker_state]) {
        s->paste_marker_state++;
        if (s->paste_marker_state == expected_len) {
            commitPaste(s);
            s->in_paste = false;
            s->paste_marker_state = 0;
        }
        return;
    }
    if (s->paste_marker_state > 0) {
        // Partial match broken — emit the matched bytes as literal content,
        // then re-interpret c from a fresh state (it may start a new marker).
        flushPasteMarker(s);
        processPasteByte(s, c);
        return;
    }
    s->paste_buf.push_back(c);
}

// ---- Prefix history search (up-line-or-beginning-search) -------------------

static void prefixSearchStart(InputState *s) {
    // Anchor = buffer[0..pos]. Snapshot orig buf so Down past the newest match
    // can restore the line you were editing.
    s->prefix_anchor_len = s->pos;
    memcpy(s->prefix_anchor, s->buf, s->pos);
    s->prefix_anchor[s->pos] = '\0';
    s->prefix_cursor = s->pos;
    memcpy(s->prefix_orig_buf, s->buf, s->len);
    s->prefix_orig_buf[s->len] = '\0';
    s->prefix_orig_len = s->len;
    s->prefix_orig_pos = s->pos;
    // Start searching from one past the newest finalized entry. finalizedCount
    // excludes the current editing slot so the anchor's own in-progress line
    // doesn't match itself.
    s->prefix_index = finalizedCount();
}

static void prefixSearchApply(InputState *s, const char *entry) {
    strncpy(s->buf, entry, s->buflen);
    s->buf[s->buflen] = '\0';
    s->len = strlen(s->buf);
    s->pos = (s->prefix_cursor <= s->len) ? s->prefix_cursor : s->len;
    bufferChanged();
}

// Walk to older match. Returns true if a match was found (buf updated).
static bool prefixSearchOlder(InputState *s) {
    for (int i = s->prefix_index - 1; i >= 0; i--) {
        const char *e = history[i];
        if (strncmp(e, s->prefix_anchor, s->prefix_anchor_len) == 0) {
            s->prefix_index = i;
            prefixSearchApply(s, e);
            return true;
        }
    }
    // No older match — stay on current entry (buf unchanged), beep-equivalent.
    return false;
}

// Walk to newer match. Returns true if buf was updated. On overshoot past the
// newest match, restores the pre-search buffer and clears in_prefix_search.
static bool prefixSearchNewer(InputState *s) {
    int n = finalizedCount();
    for (int i = s->prefix_index + 1; i < n; i++) {
        const char *e = history[i];
        if (strncmp(e, s->prefix_anchor, s->prefix_anchor_len) == 0) {
            s->prefix_index = i;
            prefixSearchApply(s, e);
            return true;
        }
    }
    // Past the newest match — restore the original buffer and cursor.
    memcpy(s->buf, s->prefix_orig_buf, s->prefix_orig_len);
    s->buf[s->prefix_orig_len] = '\0';
    s->len = s->prefix_orig_len;
    s->pos = s->prefix_orig_pos;
    s->in_prefix_search = false;
    s->prefix_index = n; // past-the-end so subsequent Down is a no-op
    bufferChanged();
    return true;
}

static void exitLineSearch(InputState *s) {
    s->in_line_search = false;
    s->line_search_query_len = 0;
}

#define CTRL_A 1
#define CTRL_B 2
#define CTRL_C 3
#define CTRL_D 4
#define CTRL_E 5
#define CTRL_F 6
#define CTRL_H 8
#define CTRL_K 11
#define CTRL_R 18
#define CTRL_S 19
#define CTRL_L 12
#define CTRL_N 14
#define CTRL_P 16
#define CTRL_T 20
#define CTRL_U 21
#define CTRL_W 23
#define CTRL_Y 25
#define ENTER 13
#define ESC 27
#define BACKSPACE 127

// ---- N-API context ---------------------------------------------------------

struct EngineCtx {
    uv_poll_t *poll = nullptr;
    Napi::FunctionReference onLine;
    Napi::FunctionReference onRender;
    Napi::FunctionReference onCompletion;
    Napi::FunctionReference onEscResponse;
};

static EngineCtx *g_ctx = nullptr;

static int getColumns() {
    struct winsize ws;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) == -1 || ws.ws_col == 0) return 80;
    return ws.ws_col;
}

// Called whenever the buffer changes — invalidates suggestion and bumps ID.
static void bufferChanged() {
    g_state.suggestion.clear();
    g_state.suggestion_id++;
}

// Collect an escape-sequence payload (DCS: ESC P ... ST; OSC: ESC ] ... ST|BEL).
// Reads byte-by-byte from ifd; terminals send these atomically so short blocks
// (VMIN=1, VTIME=0) are effectively bounded by terminal response latency.
// Returns the payload (without introducer or terminator) on success, or
// std::nullopt on malformed / oversized input. Caller has already consumed
// ESC and the introducer byte ('P' or ']').
// Blocking read of a single byte from fd, resilient to non-blocking state.
// Returns 1 on success, 0 on EOF / timeout, -1 on hard error. Uses poll() with
// a generous timeout so OSC/DCS payloads arriving in chunks don't truncate if
// the fd happens to be non-blocking (libuv/Node may set O_NONBLOCK on stdin).
static ssize_t readByteResilient(int fd, char *out) {
    while (true) {
        ssize_t n = read(fd, out, 1);
        if (n == 1) return 1;
        if (n == 0) return 0;
        if (errno == EINTR) continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK) return -1;
        // EAGAIN — wait for readability. Terminal-originated OSC/DCS should
        // arrive within ms; 1s cap catches a hung peer without hanging jsh.
        struct pollfd pfd = { fd, POLLIN, 0 };
        int pr = poll(&pfd, 1, 1000);
        if (pr <= 0) return 0; // timeout or error — abandon payload
    }
}

static std::optional<std::string> readEscPayload(int fd, char introducer) {
    std::string payload;
    const size_t MAX = 8192;
    while (payload.size() < MAX) {
        char c;
        if (readByteResilient(fd, &c) != 1) return std::nullopt;

        // OSC accepts BEL as terminator.
        if (introducer == ']' && c == 0x07) return payload;

        // ST is ESC \ for both DCS and OSC.
        if (c == 0x1b) {
            char c2;
            if (readByteResilient(fd, &c2) != 1) return std::nullopt;
            if (c2 == '\\') return payload;
            // Stray ESC inside payload — include both bytes and continue.
            payload.push_back(c);
            payload.push_back(c2);
            continue;
        }

        payload.push_back(c);
    }
    return std::nullopt; // exceeded MAX
}

static void deliverEscResponse(char introducer, const std::string& payload) {
    if (!g_ctx || g_ctx->onEscResponse.IsEmpty()) return;
    Napi::Env env = g_ctx->onEscResponse.Env();
    Napi::HandleScope scope(env);
    const char* typeStr = (introducer == 'P') ? "DCS" : "OSC";
    g_ctx->onEscResponse.Call({
        Napi::String::New(env, typeStr),
        Napi::String::New(env, payload),
    });
}

static void notifyRender() {
    if (!g_ctx || g_ctx->onRender.IsEmpty()) return;
    Napi::Env env = g_ctx->onRender.Env();
    Napi::HandleScope scope(env);
    Napi::Object state = Napi::Object::New(env);
    state.Set("buf", Napi::String::New(env, g_state.buf, g_state.len));
    state.Set("pos", Napi::Number::New(env, static_cast<double>(g_state.pos)));
    state.Set("len", Napi::Number::New(env, static_cast<double>(g_state.len)));
    state.Set("cols", Napi::Number::New(env, static_cast<double>(getColumns())));
    state.Set("suggestionId", Napi::Number::New(env, static_cast<double>(g_state.suggestion_id)));
    if (!g_state.suggestion.empty()) {
        // Ghost text: the part of the suggestion after the current buffer.
        if (g_state.suggestion.size() > g_state.len &&
            g_state.suggestion.compare(0, g_state.len, g_state.buf, g_state.len) == 0) {
            state.Set("suggestion", Napi::String::New(env, g_state.suggestion.c_str() + g_state.len));
        }
    }
    if (g_state.in_search) {
        state.Set("searchQuery", Napi::String::New(env, g_state.search_query, g_state.search_query_len));
        // match_index: -1 = no match; -2 = matched in the live buffer;
        // 0+ = history entry. Anything other than -1 is a match for the UI.
        state.Set("searchMatch", Napi::Boolean::New(env, g_state.search_match_index != -1));
    }
    if (g_state.in_line_search) {
        state.Set("lineSearchQuery", Napi::String::New(env, g_state.line_search_query, g_state.line_search_query_len));
    }
    if (g_state.in_completion && g_state.completion_idx < g_state.completion_descriptions.size()) {
        auto& desc = g_state.completion_descriptions[g_state.completion_idx];
        if (!desc.empty()) {
            state.Set("completionDesc", Napi::String::New(env, desc));
        }
    }
    if (g_state.menu_state != 0 && g_state.menu_rows > 0) {
        auto lines = menuRenderLines(&g_state);
        Napi::Array arr = Napi::Array::New(env, lines.size());
        for (size_t i = 0; i < lines.size(); i++) {
            arr.Set(i, Napi::String::New(env, lines[i]));
        }
        state.Set("menuLines", arr);
    }
    g_ctx->onRender.Call({state});
}

// ---- Completion support ----------------------------------------------------

static std::vector<std::string> extractCompletionArray(Napi::Array arr) {
    std::vector<std::string> entries;
    for (uint32_t i = 0; i < arr.Length(); i++) {
        Napi::Value item = arr.Get(i);
        if (item.IsString()) entries.push_back(item.As<Napi::String>().Utf8Value());
    }
    return entries;
}

// Splice: buf = completion_pre + entry + completion_tail. Cursor ends at
// the end of the inserted entry (i.e., completion_pre.size() + entry.size()).
static void spliceCompletion(InputState *s, const std::string &entry) {
    size_t pre_len = s->completion_pre.size();
    size_t entry_len = entry.size();
    size_t tail_len = s->completion_tail.size();
    size_t total = pre_len + entry_len + tail_len;
    if (total > s->buflen) {
        // Truncate tail first, then entry, then pre — keep what's most
        // structurally important.
        if (tail_len > 0) {
            size_t drop = std::min(tail_len, total - s->buflen);
            tail_len -= drop;
            total -= drop;
        }
        if (total > s->buflen) {
            size_t drop = std::min(entry_len, total - s->buflen);
            entry_len -= drop;
            total -= drop;
        }
    }
    memcpy(s->buf, s->completion_pre.data(), pre_len);
    memcpy(s->buf + pre_len, entry.data(), entry_len);
    memcpy(s->buf + pre_len + entry_len, s->completion_tail.data(), tail_len);
    s->buf[total] = '\0';
    s->len = total;
    s->pos = pre_len + entry_len;
}

// Apply current completion entry to the buffer.
// Does NOT call bufferChanged() — completion cycling shouldn't reset the cache.
static void applyCurrentCompletion(InputState *s) {
    s->suggestion.clear(); // Hide ghost text during completion cycling.
    if (s->completion_idx < s->completion_entries.size()) {
        spliceCompletion(s, s->completion_entries[s->completion_idx]);
    } else {
        // Cycled back to original.
        strncpy(s->buf, s->completion_original.c_str(), s->buflen);
        s->buf[s->buflen] = '\0';
        s->len = strlen(s->buf);
        s->pos = s->completion_end <= s->len ? s->completion_end : s->len;
    }
    notifyRender();
}

// ---- Menu-complete helpers -------------------------------------------------

// Display-width of an ASCII/UTF-8 string, ignoring ANSI escape runs. Completion
// entries typically don't contain ANSI, but be defensive.
static size_t entryDisplayWidth(const std::string &s) {
    size_t w = 0;
    for (size_t i = 0; i < s.size(); ) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        if (c == 0x1b) { // skip CSI/SS3 sequences
            i++;
            if (i < s.size() && (s[i] == '[' || s[i] == 'O')) i++;
            while (i < s.size() && s[i] < 0x40) i++;
            if (i < s.size()) i++;
            continue;
        }
        size_t clen = graphemeNextLen(s.c_str(), i, s.size());
        if (clen == 0) { i++; continue; }
        w += graphemeClusterWidth(s.c_str() + i, clen);
        i += clen;
    }
    return w;
}

// Helper: fetch the display string for entry `i` — prefers the explicit
// `completion_displays[i]` if set, otherwise falls back to the spliced text.
static const std::string &menuEntryDisplay(const InputState *s, size_t i) {
    if (i < s->completion_displays.size() && !s->completion_displays[i].empty()) {
        return s->completion_displays[i];
    }
    return s->completion_entries[i];
}

// Compute grid dimensions and column width. Column width is based on the
// widest *display* string (not the spliced-text), since that's what the
// user sees.
static void menuLayout(InputState *s) {
    size_t n = s->completion_entries.size();
    if (n == 0) { s->menu_rows = s->menu_cols = 0; return; }
    s->menu_display_prefix_len = 0;
    size_t longest = 0;
    for (size_t i = 0; i < n; i++) {
        size_t w = entryDisplayWidth(menuEntryDisplay(s, i));
        if (w > longest) longest = w;
    }
    const int gap = 2;
    s->menu_col_width = static_cast<int>(longest) + gap;
    int term_cols = getColumns();
    int cols = (term_cols > 0 && s->menu_col_width > 0)
                 ? std::max(1, term_cols / s->menu_col_width)
                 : 1;
    // Don't create empty trailing cells if we have fewer entries than cols.
    if (cols > static_cast<int>(n)) cols = static_cast<int>(n);
    s->menu_cols = cols;
    s->menu_rows = (static_cast<int>(n) + cols - 1) / cols;
}

// Convert the grid to display-ready lines. Each line covers all visible
// columns for one grid row. The selected cell (in state 2) is wrapped in
// inverse video.
static std::vector<std::string> menuRenderLines(InputState *s) {
    std::vector<std::string> lines;
    if (s->menu_rows == 0 || s->menu_cols == 0) return lines;
    int viewport = std::min(s->menu_rows, s->menu_viewport_max);
    int start = s->menu_viewport_start;
    const int gap = 2;
    for (int r = start; r < start + viewport && r < s->menu_rows; r++) {
        std::string line;
        for (int c = 0; c < s->menu_cols; c++) {
            size_t idx = static_cast<size_t>(r) * s->menu_cols + c;
            if (idx >= s->completion_entries.size()) break;
            const std::string &disp = menuEntryDisplay(s, idx);
            bool selected = (s->menu_state == 2 && r == s->menu_row && c == s->menu_col);
            // Pick up LS_COLORS style for this cell, if any. Inverse-video
            // (selected) overrides the color so the highlight is visible.
            const std::string *sgr = nullptr;
            if (!selected && idx < s->completion_types.size()) {
                sgr = lookupLsColor(s->completion_types[idx], disp);
            }
            if (selected) line.append("\x1b[7m");
            else if (sgr) { line.append("\x1b["); line.append(*sgr); line.append("m"); }
            line.append(disp);
            // For non-selected cells close the SGR right after the text so
            // padding isn't colored (LS_COLORS background codes would bleed).
            // For selected cells keep the inverse-video active through the
            // padding — matches zsh's full-column selection highlight.
            size_t ew = entryDisplayWidth(disp);
            int pad = s->menu_col_width - gap - static_cast<int>(ew);
            if (selected) {
                if (pad > 0) line.append(pad, ' ');
                line.append("\x1b[27m");
            } else {
                if (sgr) line.append("\x1b[0m");
                if (pad > 0) line.append(pad, ' ');
            }
            line.append(gap, ' ');
        }
        lines.push_back(std::move(line));
    }
    return lines;
}

// Apply the currently-selected entry to the buffer, splicing it into the
// pre-menu position (buf[completion_start..completion_end]) and preserving
// the surrounding text that was outside that range.
static void menuApplySelection(InputState *s) {
    size_t idx = static_cast<size_t>(s->menu_row) * s->menu_cols + s->menu_col;
    if (idx >= s->completion_entries.size()) return;
    spliceCompletion(s, s->completion_entries[idx]);
    bufferChanged();
}

// Move the selection by (dr, dc). Wraps at edges in both directions. Adjusts
// viewport so the new selection stays visible.
static void menuNavigate(InputState *s, int dr, int dc) {
    if (s->menu_rows == 0 || s->menu_cols == 0) return;
    size_t n = s->completion_entries.size();
    auto cellOccupied = [&](int r, int c) {
        size_t idx = static_cast<size_t>(r) * s->menu_cols + c;
        return idx < n;
    };
    int nr = s->menu_row + dr;
    int nc = s->menu_col + dc;
    // Horizontal wrap within the same row (left/right within the grid).
    if (dc != 0) {
        if (nc < 0) { nc = s->menu_cols - 1; while (!cellOccupied(nr, nc)) nc--; }
        else if (nc >= s->menu_cols || !cellOccupied(nr, nc)) { nc = 0; }
    }
    // Vertical wrap.
    if (dr != 0) {
        if (nr < 0) {
            // Wrap to bottom; find the last row that has a cell at nc.
            nr = s->menu_rows - 1;
            while (nr > 0 && !cellOccupied(nr, nc)) nr--;
        } else if (nr >= s->menu_rows) {
            nr = 0;
        } else if (!cellOccupied(nr, nc)) {
            // Last row is partial — skip empty trailing slot.
            nr = 0;
        }
    }
    s->menu_row = nr;
    s->menu_col = nc;
    // Scroll viewport to keep selection visible.
    int viewport = std::min(s->menu_rows, s->menu_viewport_max);
    if (s->menu_row < s->menu_viewport_start) {
        s->menu_viewport_start = s->menu_row;
    } else if (s->menu_row >= s->menu_viewport_start + viewport) {
        s->menu_viewport_start = s->menu_row - viewport + 1;
    }
    menuApplySelection(s);
}

// Tab (or Shift-Tab) cycling in state 2. Advances one cell, wrapping to the
// next row when hitting the right edge; from the last cell wraps back to
// (0, 0).
static void menuCycle(InputState *s, int dir) {
    if (s->menu_rows == 0 || s->menu_cols == 0) return;
    size_t n = s->completion_entries.size();
    size_t idx = static_cast<size_t>(s->menu_row) * s->menu_cols + s->menu_col;
    if (dir > 0) {
        idx = (idx + 1) % n;
    } else {
        idx = (idx == 0) ? n - 1 : idx - 1;
    }
    s->menu_row = static_cast<int>(idx) / s->menu_cols;
    s->menu_col = static_cast<int>(idx) % s->menu_cols;
    int viewport = std::min(s->menu_rows, s->menu_viewport_max);
    if (s->menu_row < s->menu_viewport_start) s->menu_viewport_start = s->menu_row;
    else if (s->menu_row >= s->menu_viewport_start + viewport)
        s->menu_viewport_start = s->menu_row - viewport + 1;
    menuApplySelection(s);
}

static void menuClose(InputState *s, bool restore) {
    if (restore && s->menu_state == 2) {
        size_t len = s->menu_orig_len;
        if (len > s->buflen) len = s->buflen;
        memcpy(s->buf, s->menu_orig_buf.c_str(), len);
        s->buf[len] = '\0';
        s->len = len;
        s->pos = s->menu_orig_pos <= len ? s->menu_orig_pos : len;
        bufferChanged();
    }
    s->menu_state = 0;
    s->menu_rows = s->menu_cols = 0;
    s->menu_row = s->menu_col = 0;
    s->menu_viewport_start = 0;
    s->in_completion = 0;
    s->completion_entries.clear();
    s->completion_descriptions.clear();
    s->completion_displays.clear();
    s->completion_types.clear();
    s->completion_original.clear();
    s->menu_orig_buf.clear();
}

// Start completion with a set of entries and optional descriptions. The
// caller must have already set completion_start / completion_end /
// completion_pre / completion_tail (the splice
// boundary — typically word_end, past the word spanning the cursor).
static void startCompletion(InputState *s, std::vector<std::string> entries, std::vector<std::string> descs = {}) {
    if (entries.empty()) return;
    s->completion_original = std::string(s->buf, s->len);
    s->completion_entries = std::move(entries);
    s->completion_descriptions = std::move(descs);
    s->completion_idx = 0;
    s->in_completion = 1;
    applyCurrentCompletion(s);
}

// Cycle to next completion entry.
static void nextCompletion(InputState *s) {
    s->completion_idx = (s->completion_idx + 1) % (s->completion_entries.size() + 1);
    applyCurrentCompletion(s);
}

// Returns: 0 = consumed, c = pass through.
static int completeLine(InputState *s, char c) {
    if (!g_ctx || g_ctx->onCompletion.IsEmpty()) return c;

    if (c == 9) { // TAB
        // Menu mode: Tab is the primary navigation key. State 1 (grid shown,
        // no selection) → state 2 (select first); state 2 → cycle forward.
        if (s->menu_state == 1) {
            s->menu_orig_buf = std::string(s->buf, s->len);
            s->menu_orig_len = s->len;
            s->menu_orig_pos = s->pos;
            s->menu_state = 2;
            s->menu_row = 0;
            s->menu_col = 0;
            menuApplySelection(s);
            notifyRender();
            return 0;
        }
        if (s->menu_state == 2) {
            menuCycle(s, +1);
            notifyRender();
            return 0;
        }
        if (s->in_completion) {
            // Legacy cycle mode — advance to next candidate.
            nextCompletion(s);
            return 0;
        }
        // First Tab — fetch completions from JS. Pass the full buffer + cursor
        // position; JS uses the jsh lexer to find the token at the cursor and
        // returns either a plain string[] (legacy: native infers word range)
        // or { entries, replaceStart, replaceEnd } (preferred: explicit range).
        Napi::Env env = g_ctx->onCompletion.Env();
        Napi::HandleScope scope(env);
        Napi::Value result = g_ctx->onCompletion.Call({
            Napi::String::New(env, s->buf, s->len),
            Napi::Number::New(env, static_cast<double>(s->pos)),
        });

        std::vector<std::string> entries;
        std::vector<std::string> displays;
        std::vector<std::string> types;
        size_t replaceStart = 0, replaceEnd = 0;
        bool ambiguous = false;
        bool ok = false;
        if (result.IsArray()) {
            entries = extractCompletionArray(result.As<Napi::Array>());
            replaceStart = 0;
            replaceEnd = s->pos;
            while (replaceEnd < s->len &&
                   !std::isspace(static_cast<unsigned char>(s->buf[replaceEnd]))) {
                replaceEnd++;
            }
            ok = true;
        } else if (result.IsObject() && !result.IsPromise()) {
            Napi::Object obj = result.As<Napi::Object>();
            if (obj.Has("entries") && obj.Get("entries").IsArray()) {
                entries = extractCompletionArray(obj.Get("entries").As<Napi::Array>());
            }
            if (obj.Has("displays") && obj.Get("displays").IsArray()) {
                displays = extractCompletionArray(obj.Get("displays").As<Napi::Array>());
            }
            if (obj.Has("types") && obj.Get("types").IsArray()) {
                types = extractCompletionArray(obj.Get("types").As<Napi::Array>());
            }
            replaceStart = obj.Has("replaceStart") && obj.Get("replaceStart").IsNumber()
                ? obj.Get("replaceStart").As<Napi::Number>().Uint32Value() : s->pos;
            replaceEnd = obj.Has("replaceEnd") && obj.Get("replaceEnd").IsNumber()
                ? obj.Get("replaceEnd").As<Napi::Number>().Uint32Value() : s->pos;
            if (obj.Has("ambiguous") && obj.Get("ambiguous").IsBoolean()) {
                ambiguous = obj.Get("ambiguous").As<Napi::Boolean>().Value();
            }
            if (replaceStart > s->len) replaceStart = s->len;
            if (replaceEnd > s->len) replaceEnd = s->len;
            if (replaceEnd < replaceStart) replaceEnd = replaceStart;
            ok = true;
        } else if (result.IsPromise()) {
            s->waiting_for_completions = true;
            if (g_ctx->poll) uv_poll_stop(g_ctx->poll);
            return 0;
        }
        if (!ok || entries.empty()) return c;

        // Splice context (shared by cycle and menu modes).
        s->completion_start = replaceStart;
        s->completion_end = replaceEnd;
        s->completion_pre = std::string(s->buf, replaceStart);
        s->completion_tail = std::string(s->buf + replaceEnd, s->len - replaceEnd);
        // Single match: splice and commit. Append a trailing space unless
        //   - it's a directory (already ends in `/`),
        //   - the existing tail starts with whitespace,
        //   - or the caller flagged the result as `ambiguous` (LCP extension
        //     across multiple real matches — next Tab should re-query).
        // Do NOT enter cycle / menu mode: next Tab starts fresh.
        if (entries.size() == 1) {
            std::string e = std::move(entries[0]);
            bool endsSlash = !e.empty() && e.back() == '/';
            bool tailHasSpace = !s->completion_tail.empty() &&
                                std::isspace(static_cast<unsigned char>(s->completion_tail[0]));
            if (!ambiguous && !endsSlash && !tailHasSpace) e += ' ';
            spliceCompletion(s, e);
            bufferChanged();
            notifyRender();
            return 0;
        }
        if (g_menu_complete) {
            s->completion_original = std::string(s->buf, s->len);
            s->completion_entries = std::move(entries);
            s->completion_displays = std::move(displays);
            s->completion_types = std::move(types);
            s->completion_idx = 0;
            s->menu_state = 1;
            s->menu_row = 0;
            s->menu_col = 0;
            s->menu_viewport_start = 0;
            menuLayout(s);
            notifyRender();
            return 0;
        }
        s->completion_displays = std::move(displays);
        s->completion_types = std::move(types);
        startCompletion(s, std::move(entries));
        return 0;
    }

    // Non-TAB while in completion / menu mode.
    if (s->menu_state != 0) {
        // Enter in menu mode = accept the selection and return to the prompt
        // (don't submit the line — user hits Enter again to run the command).
        // Swallow Enter here so the main switch's case ENTER doesn't trigger.
        if (c == ENTER) {
            menuClose(s, /*restore=*/false);
            notifyRender();
            return 0;
        }
        // `/` right after a completion that already ends in `/` (directory
        // match): swallow the duplicate so "ls src/" + Tab accepting "api/"
        // + "/" doesn't produce "src/api//".
        if (c == '/' && s->len > 0 && s->buf[s->len - 1] == '/') {
            menuClose(s, /*restore=*/false);
            notifyRender();
            return 0;
        }
        // Any other key: accept current state and dispatch the key normally.
        // State 1 closes without touching buf; state 2 keeps the current
        // selection in buf.
        menuClose(s, /*restore=*/false);
        return c;
    }
    // If completion ends with '/' and user types '/', swallow the duplicate.
    if (c == '/' && s->len > 0 && s->buf[s->len - 1] == '/') {
        s->in_completion = 0;
        s->completion_entries.clear();
        s->completion_descriptions.clear();
        s->completion_original.clear();
        bufferChanged();
        notifyRender();
        return 0; // Swallowed.
    }
    s->in_completion = 0;
    s->completion_entries.clear();
    s->completion_descriptions.clear();
    s->completion_displays.clear();
    s->completion_types.clear();
    s->completion_original.clear();
    return c;
}

// ---- Keystroke dispatch (editFeed) -----------------------------------------

// Returns: 0 = need more input, 1 = line complete, -1 = error/EOF/ctrl-c
static int editFeed(InputState *s, char **out_line, int *out_errno) {
    char c;
    int nread = read(s->ifd, &c, 1);
    if (nread < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
        *out_errno = errno;
        return -1;
    }
    if (nread == 0) { *out_errno = 0; return -1; } // EOF

    // Prefix history search is only sticky across consecutive Up/Down. Any
    // other key breaks the streak — clear at the top; the Up/Down handlers
    // below re-set the flag when they continue the search.
    bool was_in_prefix_search = s->in_prefix_search;
    s->in_prefix_search = false;

    // Kill/yank streak tracking. Any action other than a kill breaks the
    // accumulator (next kill pushes the old cut_buf to the ring and starts
    // fresh). Any action other than a yank makes Alt-Y a no-op.
    bool was_kill = s->last_was_kill;
    s->last_was_kill = false;
    bool was_yank = s->last_was_yank;
    s->last_was_yank = false;

    // Bracketed paste: once we've matched ESC[200~, all subsequent bytes
    // accumulate in a side buffer until the ESC[201~ end marker arrives. Drain
    // everything available per editFeed call — a multi-KB paste would
    // otherwise take thousands of poll round-trips.
    if (s->in_paste) {
        processPasteByte(s, c);
        while (s->in_paste) {
            struct pollfd pfd = { s->ifd, POLLIN, 0 };
            if (poll(&pfd, 1, 0) <= 0) break;
            char next;
            if (read(s->ifd, &next, 1) != 1) break;
            processPasteByte(s, next);
        }
        notifyRender();
        return 0;
    }

    // Pending Esc: we previously saw Esc with no follow-up in the buffer.
    // Treat this byte as the second byte of an Esc-prefixed sequence —
    // unless it's another Esc, in which case keep pending (user rolled the
    // Esc key, next byte after this one becomes the Meta-byte).
    if (s->esc_pending) {
        s->esc_pending = false;
        if (c == ESC) {
            s->esc_pending = true;
            return 0;
        }
        dispatchEscPrefix(s, c, was_in_prefix_search, was_kill, was_yank);
        return 0;
    }

    // Reverse search mode handling.
    if (s->in_search) {
        if (c == CTRL_R) {
            // Search for next older match.
            searchHistoryReverse(s, true);
            notifyRender();
            return 0;
        }
        if (c == ENTER) {
            // Accept the current match and execute it.
            exitSearchMode(s);
            if (history_len > 0) { history_len--; free(history[history_len]); }
            *out_line = strdup(s->buf);
            return 1;
        }
        if (c == CTRL_C) {
            // Cancel search and restore the pre-search buffer.
            exitSearchMode(s);
            memcpy(s->buf, s->orig_buf, s->orig_len);
            s->buf[s->orig_len] = '\0';
            s->len = s->orig_len;
            s->pos = s->orig_pos;
            notifyRender();
            return 0;
        }
        // ESC and arrow-like escape sequences fall through: we exit search
        // below (keeping the matched buf) and let the main switch interpret
        // the rest of the sequence as ordinary editing (cursor movement, etc.).
        if (c == BACKSPACE || c == CTRL_H) {
            // Delete last char from search query, re-search from scratch.
            if (s->search_query_len > 0) {
                s->search_query_len--;
                s->search_query[s->search_query_len] = '\0';
                s->search_match_index = -1;
                searchHistoryReverse(s, false);
            }
            notifyRender();
            return 0;
        }
        if (c >= 32 && c < 127) {
            // Add to search query and re-search from scratch. Resetting
            // match_index lets the pre-search buffer participate again when
            // the longer query happens to match it.
            if (s->search_query_len < sizeof(s->search_query) - 1) {
                s->search_query[s->search_query_len++] = c;
                s->search_query[s->search_query_len] = '\0';
                s->search_match_index = -1;
                searchHistoryReverse(s, false);
            }
            notifyRender();
            return 0;
        }
        // Any other key: accept match, exit search, and process the key normally.
        exitSearchMode(s);
        notifyRender();
        // Fall through to normal handling of this key.
    }

    // Inline forward search mode (Ctrl-S).
    if (s->in_line_search) {
        if (c == CTRL_S) {
            // Repeat search forward.
            lineSearchForward(s);
            notifyRender();
            return 0;
        }
        if (c == CTRL_C) {
            exitLineSearch(s);
            notifyRender();
            return 0;
        }
        if (c == BACKSPACE || c == CTRL_H) {
            if (s->line_search_query_len > 0) {
                s->line_search_query_len--;
                s->line_search_query[s->line_search_query_len] = '\0';
                s->line_search_start = 0;
                lineSearchForward(s);
            }
            notifyRender();
            return 0;
        }
        if (c == ENTER) {
            // Exit search and execute the line (zsh behavior).
            exitLineSearch(s);
            if (history_len > 0) { history_len--; free(history[history_len]); }
            *out_line = strdup(s->buf);
            return 1;
        }
        if (c >= 32 && c < 127) {
            if (s->line_search_query_len < sizeof(s->line_search_query) - 1) {
                s->line_search_query[s->line_search_query_len++] = c;
                s->line_search_query[s->line_search_query_len] = '\0';
                s->line_search_start = 0;
                lineSearchForward(s);
            }
            notifyRender();
            return 0;
        }
        // Any other key (ESC, control chars, etc.): exit search and fall through
        // to normal key processing so escape sequences are handled correctly.
        exitLineSearch(s);
        notifyRender();
    }

    // Completion handling
    if ((s->in_completion || s->menu_state != 0 || c == 9) && !g_ctx->onCompletion.IsEmpty()) {
        int retval = completeLine(s, c);
        if (retval == 0) return 0; // Consumed by completion
        if (c == 9 && retval == 9) return 0; // Tab with no completions — don't insert literal tab
        c = retval;
    }

    switch (c) {
    case ENTER:
        // Menu mode: Enter accepts the current selection and stays at the
        // prompt (buffer already holds the tentative insertion). Doesn't
        // submit the line — user hits Enter again to run the command.
        if (s->menu_state != 0) {
            menuClose(s, /*restore=*/false);
            notifyRender();
            return 0;
        }
        // Remove temp history entry
        if (history_len > 0) {
            history_len--;
            free(history[history_len]);
        }
        *out_line = strdup(s->buf);
        return 1;

    case CTRL_C:
        // Remove temp history entry (same as ENTER and Ctrl-D paths).
        if (history_len > 0) {
            history_len--;
            free(history[history_len]);
        }
        // Clear suggestion so ghost text doesn't linger.
        s->suggestion.clear();
        *out_errno = EAGAIN;
        return -1;

    case BACKSPACE:
    case CTRL_H:
        editBackspace(s);
        notifyRender();
        break;

    case CTRL_D:
        if (s->len > 0) {
            editDelete(s);
            notifyRender();
        } else {
            // Empty line + Ctrl-D = EOF
            if (history_len > 0) {
                history_len--;
                free(history[history_len]);
            }
            *out_errno = ENOENT;
            return -1;
        }
        break;

    case CTRL_T:
        if (s->pos > 0 && s->pos < s->len) {
            char tmp[32];
            size_t prevlen = utf8PrevCharLen(s->buf, s->pos);
            size_t currlen = utf8NextCharLen(s->buf, s->pos, s->len);
            size_t prevstart = s->pos - prevlen;
            memcpy(tmp, s->buf + s->pos, currlen);
            memmove(s->buf + prevstart + currlen, s->buf + prevstart, prevlen);
            memcpy(s->buf + prevstart, tmp, currlen);
            if (s->pos + currlen <= s->len) s->pos += currlen;
            bufferChanged();
            notifyRender();
        }
        break;

    case CTRL_B: editMoveLeft(s); notifyRender(); break;
    case CTRL_F:
        if (s->pos == s->len && !s->suggestion.empty() &&
            s->suggestion.size() > s->len &&
            s->suggestion.compare(0, s->len, s->buf, s->len) == 0) {
            size_t slen = s->suggestion.size();
            if (slen <= s->buflen) {
                memcpy(s->buf, s->suggestion.c_str(), slen);
                s->buf[slen] = '\0';
                s->pos = s->len = slen;
                bufferChanged();
            }
        } else {
            editMoveRight(s);
        }
        notifyRender();
        break;
    case CTRL_P:
        historyUpOrPrefixSearch(s, was_in_prefix_search);
        notifyRender();
        break;
    case CTRL_N:
        historyDownOrPrefixSearch(s, was_in_prefix_search);
        notifyRender();
        break;
    case CTRL_A: editMoveHome(s); notifyRender(); break;
    case CTRL_E: editMoveEnd(s); notifyRender(); break;
    case CTRL_S: enterLineSearch(s); notifyRender(); break;

    case CTRL_U:
        // kill-whole-line: the killed range covers both sides of the cursor.
        // Treat as a non-coalescing kill (pass was_kill=false) so the whole
        // line becomes its own ring entry.
        doKill(s, 0, s->len, /*was_kill=*/false, /*front=*/false);
        notifyRender();
        break;

    case CTRL_K:
        doKill(s, s->pos, s->len, was_kill, /*front=*/false);
        notifyRender();
        break;

    case CTRL_L: {
        // Clear screen: write escape sequence, then render
        [[maybe_unused]] auto _w = write(s->ofd, "\x1b[H\x1b[2J", 7);
        notifyRender();
        break;
    }

    case CTRL_R:
        enterSearchMode(s);
        notifyRender();
        break;

    case CTRL_W:
        // zsh binds ^W to backward-kill-word (word-char-bounded, same as
        // Alt-Backspace) rather than readline's whitespace-only flavor.
        editKillWordLeft(s, was_kill);
        notifyRender();
        break;

    case CTRL_Y:
        yank(s);
        notifyRender();
        break;

    case ESC: {
        // Fast path: if the follow-up byte is already in the kernel buffer
        // (CSI/SS3 burst from the terminal, or DCS/OSC payload), read and
        // dispatch synchronously. Otherwise mark Esc pending — the next
        // editFeed tick will treat the arriving byte as the second byte of
        // this Esc sequence, however long the user takes. Mirrors zsh's
        // "wait indefinitely for the next key" behavior without blocking the
        // Node event loop.
        struct pollfd pfd = { s->ifd, POLLIN, 0 };
        if (poll(&pfd, 1, 0) <= 0) {
            // In menu mode, bare Esc cancels immediately (don't pend — user
            // wants out now). Arrow keys still work because their ESC byte
            // arrives together with `[A` and poll-0 sees data.
            if (s->menu_state != 0) {
                menuClose(s, /*restore=*/true);
                notifyRender();
                break;
            }
            s->esc_pending = true;
            break;
        }
        char first;
        if (read(s->ifd, &first, 1) == -1) break;
        dispatchEscPrefix(s, first, was_in_prefix_search, was_kill, was_yank);
        break;
    }

    default: {
        // UTF-8 multi-byte handling
        char utf8[4];
        int utf8len = utf8ByteLen(static_cast<unsigned char>(c));
        utf8[0] = c;
        int actual = 1;
        for (int i = 1; i < utf8len; i++) {
            if (read(s->ifd, utf8+i, 1) != 1) break;
            actual++;
        }
        if (actual == utf8len) {
            editInsert(s, utf8, utf8len);
        }
        // Drop incomplete sequences silently.
        notifyRender();
        break;
    }
    }

    return 0; // Need more input
}

// ---- uv_poll callback ------------------------------------------------------

static void onPollClose(uv_handle_t *handle) {
    delete reinterpret_cast<uv_poll_t *>(handle);
}

static void pollCallback(uv_poll_t *handle, int status, int events) {
    if (!g_ctx || !g_state.active) return;
    if (status < 0 || !(events & UV_READABLE)) return;

    char *line = nullptr;
    int err = 0;
    int result = editFeed(&g_state, &line, &err);

    if (result == 0) return; // Need more input

    // Line complete or error — stop polling, restore terminal.
    // The temp history slot was already popped inside editFeed's ENTER /
    // CTRL_C / CTRL_D cases, so history contains only finalized commands
    // by the time we reach here.
    uv_poll_stop(handle);
    uv_close(reinterpret_cast<uv_handle_t *>(handle), onPollClose);
    g_ctx->poll = nullptr;
    g_state.active = false;
    disableRawMode(g_state.ifd);

    Napi::Env env = g_ctx->onLine.Env();
    Napi::HandleScope scope(env);
    if (result == 1 && line) {
        g_ctx->onLine.Call({Napi::String::New(env, line)});
        free(line);
    } else {
        Napi::Value null = env.Null();
        g_ctx->onLine.Call({null, Napi::Number::New(env, err)});
    }
}

// ---- N-API exports ---------------------------------------------------------

static Napi::Value InputStart(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "inputStart(callbacks)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object cbs = info[0].As<Napi::Object>();

    if (!g_ctx) g_ctx = new EngineCtx();

    // Store callbacks
    g_ctx->onLine = Napi::Persistent(cbs.Get("onLine").As<Napi::Function>());
    g_ctx->onRender = Napi::Persistent(cbs.Get("onRender").As<Napi::Function>());
    if (cbs.Has("onCompletion") && cbs.Get("onCompletion").IsFunction()) {
        g_ctx->onCompletion = Napi::Persistent(cbs.Get("onCompletion").As<Napi::Function>());
    }
    if (cbs.Has("onEscResponse") && cbs.Get("onEscResponse").IsFunction()) {
        g_ctx->onEscResponse = Napi::Persistent(cbs.Get("onEscResponse").As<Napi::Function>());
    }

    // Init state
    g_state.ifd = STDIN_FILENO;
    g_state.ofd = STDOUT_FILENO;
    g_state.buf[0] = '\0';
    g_state.pos = 0;
    g_state.len = 0;
    g_state.history_index = 0;
    g_state.in_completion = 0;
    g_state.completion_idx = 0;
    g_state.active = true;
    // Clear any suggestion left over from the previous editing session.
    // Otherwise an empty buffer trivially passes the prefix-match check in
    // notifyRender and the old ghost reappears before the user types.
    g_state.suggestion.clear();
    g_state.suggestion_id++;

    // Non-TTY: read entire line synchronously
    if (!isatty(g_state.ifd) && !getenv("LINENOISE_ASSUME_TTY")) {
        // Read a line from stdin
        char buf[INPUT_BUF_SIZE];
        int i = 0;
        while (i < INPUT_BUF_SIZE - 1) {
            char c;
            int n = read(g_state.ifd, &c, 1);
            if (n <= 0 || c == '\n') break;
            buf[i++] = c;
        }
        buf[i] = '\0';
        g_state.active = false;
        if (i > 0) {
            g_ctx->onLine.Call({Napi::String::New(env, buf, i)});
        } else {
            g_ctx->onLine.Call({env.Null(), Napi::Number::New(env, 0)});
        }
        return env.Undefined();
    }

    // Enter raw mode
    if (enableRawMode(g_state.ifd) == -1) {
        Napi::Error::New(env, "Failed to enable raw mode").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Add empty history entry for current editing session
    historyAdd("");
    g_state.history_index = 0;

    // Initial render
    notifyRender();

    // Start polling stdin
    uv_loop_t *loop;
    napi_get_uv_event_loop(env, &loop);
    g_ctx->poll = new uv_poll_t();
    g_ctx->poll->data = g_ctx;
    uv_poll_init(loop, g_ctx->poll, g_state.ifd);
    uv_poll_start(g_ctx->poll, UV_READABLE, pollCallback);

    return env.Undefined();
}

static Napi::Value InputStop(const Napi::CallbackInfo &info) {
    if (g_ctx && g_ctx->poll) {
        uv_poll_stop(g_ctx->poll);
        uv_close(reinterpret_cast<uv_handle_t *>(g_ctx->poll), onPollClose);
        g_ctx->poll = nullptr;
    }
    g_state.active = false;
    disableRawMode(g_state.ifd);
    return info.Env().Undefined();
}

static Napi::Value InputGetCols(const Napi::CallbackInfo &info) {
    return Napi::Number::New(info.Env(), getColumns());
}

static Napi::Value InputWriteRaw(const Napi::CallbackInfo &info) {
    if (info.Length() < 1) return info.Env().Undefined();
    if (info[0].IsString()) {
        std::string data = info[0].As<Napi::String>().Utf8Value();
        [[maybe_unused]] auto _w1 = write(g_state.ofd, data.c_str(), data.size());
    } else if (info[0].IsBuffer()) {
        Napi::Buffer<char> buf = info[0].As<Napi::Buffer<char>>();
        [[maybe_unused]] auto _w2 = write(g_state.ofd, buf.Data(), buf.Length());
    }
    return info.Env().Undefined();
}

// inputRenderLine(prompt, colorized, rprompt, cols, rawBuf, rawPos) -> { line, cursorCol }
// Pure function: computes the display line with horizontal scroll.
// rawBuf and rawPos are the plain-text buffer content and cursor position for this line.
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

    size_t pwidth = utf8StrWidthAnsi(prompt.c_str(), prompt.size());

    const char *rawBuf = rawBufStr.c_str();
    size_t rawLen = rawBufStr.size();
    if (rawPos > rawLen) rawPos = rawLen;

    size_t poscol = utf8StrWidth(rawBuf, rawPos);
    size_t lencol = utf8StrWidth(rawBuf, rawLen);

    // Horizontal scroll: trim from left if cursor would go past right edge.
    // We need to track how many bytes we skip from the raw buffer,
    // and apply the same skip to the colorized buffer.
    size_t skipBytes = 0;
    size_t skipWidth = 0;
    while (pwidth + poscol - skipWidth >= (size_t)cols) {
        size_t clen = graphemeNextLen(rawBuf, skipBytes, rawLen);
        if (clen == 0) break;
        int cwidth = graphemeClusterWidth(rawBuf + skipBytes, clen);
        skipBytes += clen;
        skipWidth += cwidth;
    }
    poscol -= skipWidth;
    lencol -= skipWidth;

    // Trim from right if still doesn't fit.
    size_t displayLen = rawLen - skipBytes;
    while (pwidth + lencol > (size_t)cols) {
        size_t clen = graphemePrevLen(rawBuf + skipBytes, displayLen, 0);
        if (clen == 0) break;
        int cw = graphemeClusterWidth(rawBuf + skipBytes + displayLen - clen, clen);
        displayLen -= clen;
        lencol -= cw;
    }

    // Build the display line.
    // For the colorized buffer, we need to extract the visible portion.
    // Since colorized has ANSI escapes, we can't just byte-slice it.
    // Approach: if no scrolling needed, use colorized as-is.
    // If scrolling, fall back to raw buffer (colorize will be re-applied by TS).
    std::string line = prompt;
    if (skipBytes == 0 && displayLen == rawLen) {
        line += colorized;
    } else {
        // Scrolled: use raw visible portion. TS can re-colorize if needed.
        line += std::string(rawBuf + skipBytes, displayLen);
    }

    // Right prompt
    size_t rpwidth = utf8StrWidthAnsi(rprompt.c_str(), rprompt.size());
    size_t used = pwidth + lencol;
    if (!rprompt.empty() && used + rpwidth + 1 <= (size_t)cols) {
        // Pad to right edge
        size_t pad = cols - used - rpwidth;
        line += std::string(pad, ' ');
        line += rprompt;
    }

    size_t cursorCol = pwidth + poscol;

    Napi::Object result = Napi::Object::New(env);
    result.Set("line", Napi::String::New(env, line));
    result.Set("cursorCol", Napi::Number::New(env, static_cast<double>(cursorCol)));
    return result;
}

// History N-API wrappers
static Napi::Value HistoryAdd(const Napi::CallbackInfo &info) {
    if (info.Length() > 0 && info[0].IsString())
        historyAdd(info[0].As<Napi::String>().Utf8Value().c_str());
    return info.Env().Undefined();
}

static Napi::Value HistorySetMaxLen(const Napi::CallbackInfo &info) {
    if (info.Length() > 0 && info[0].IsNumber())
        historySetMaxLen(info[0].As<Napi::Number>().Int32Value());
    return info.Env().Undefined();
}

static Napi::Value HistorySave(const Napi::CallbackInfo &info) {
    if (info.Length() > 0 && info[0].IsString())
        return Napi::Number::New(info.Env(),
            historySave(info[0].As<Napi::String>().Utf8Value().c_str()));
    return Napi::Number::New(info.Env(), -1);
}

static Napi::Value HistoryLoad(const Napi::CallbackInfo &info) {
    if (info.Length() > 0 && info[0].IsString())
        return Napi::Number::New(info.Env(),
            historyLoad(info[0].As<Napi::String>().Utf8Value().c_str()));
    return Napi::Number::New(info.Env(), -1);
}

// ---- History read-side N-API getters --------------------------------------
// The last entry is the live editing "temp slot" only when g_state.active is
// true (and up until pollCallback pops it on Enter). Expose helpers that
// exclude the temp slot, so JS consumers see only finalized commands.

static inline int finalizedCount() {
    if (history_len == 0) return 0;
    return g_state.active ? history_len - 1 : history_len;
}

static Napi::Value HistoryCount(const Napi::CallbackInfo &info) {
    return Napi::Number::New(info.Env(), finalizedCount());
}

static Napi::Value HistoryGet(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) return env.Null();
    int idx = info[0].As<Napi::Number>().Int32Value();
    int n = finalizedCount();
    if (idx < 0 || idx >= n) return env.Null();
    return Napi::String::New(env, history[idx]);
}

static Napi::Value HistoryAll(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    int n = finalizedCount();
    Napi::Array arr = Napi::Array::New(env, n);
    for (int i = 0; i < n; i++) {
        arr.Set(static_cast<uint32_t>(i), Napi::String::New(env, history[i]));
    }
    return arr;
}

static Napi::Value HistorySearchPrefix(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return env.Null();
    std::string prefix = info[0].As<Napi::String>().Utf8Value();
    int n = finalizedCount();
    for (int i = n - 1; i >= 0; i--) {
        const char* e = history[i];
        if (strncmp(e, prefix.c_str(), prefix.size()) == 0) {
            return Napi::String::New(env, e);
        }
    }
    return env.Null();
}

static Napi::Value SetSuggestion(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
        return env.Undefined();
    }
    uint32_t id = info[0].As<Napi::Number>().Uint32Value();
    // Only accept if the ID matches the current buffer state.
    if (id == g_state.suggestion_id && g_state.active) {
        g_state.suggestion = info[1].As<Napi::String>().Utf8Value();
        notifyRender();
    }
    return env.Undefined();
}

static Napi::Value SetInput(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return env.Undefined();
    std::string text = info[0].As<Napi::String>().Utf8Value();
    size_t len = text.size();
    if (len > g_state.buflen) len = g_state.buflen;
    memcpy(g_state.buf, text.c_str(), len);
    g_state.buf[len] = '\0';
    g_state.pos = g_state.len = len;
    bufferChanged();
    if (g_state.active) notifyRender();
    return env.Undefined();
}

static Napi::Value SetWordChars(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() >= 1 && info[0].IsString()) {
        wordchars = info[0].As<Napi::String>().Utf8Value();
    }
    return env.Undefined();
}

static Napi::Value SetCompletionStyle(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() >= 1 && info[0].IsString()) {
        std::string s = info[0].As<Napi::String>().Utf8Value();
        g_menu_complete = (s == "menu");
    }
    return env.Undefined();
}

static Napi::Value SetListColors(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() >= 1 && info[0].IsString()) {
        parseLsColors(info[0].As<Napi::String>().Utf8Value());
    } else {
        parseLsColors("");
    }
    return env.Undefined();
}

static Napi::Value SetCompletions(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!g_state.waiting_for_completions) return env.Undefined();
    g_state.waiting_for_completions = false;

    // Args: (entries, descs, replaceStart?, replaceEnd?). replaceStart < 0
    // means "legacy: compute word_end from buf" (current cursor forward to
    // next whitespace).
    std::vector<std::string> entries;
    std::vector<std::string> descs;
    std::vector<std::string> displays;
    std::vector<std::string> types;
    int rs = -1, re_ = -1;
    bool ambiguous = false;
    if (info.Length() > 0 && info[0].IsArray()) {
        entries = extractCompletionArray(info[0].As<Napi::Array>());
    }
    if (info.Length() > 1 && info[1].IsArray()) {
        descs = extractCompletionArray(info[1].As<Napi::Array>());
    }
    if (info.Length() > 2 && info[2].IsNumber()) rs = info[2].As<Napi::Number>().Int32Value();
    if (info.Length() > 3 && info[3].IsNumber()) re_ = info[3].As<Napi::Number>().Int32Value();
    if (info.Length() > 4 && info[4].IsArray()) {
        displays = extractCompletionArray(info[4].As<Napi::Array>());
    }
    if (info.Length() > 5 && info[5].IsBoolean()) {
        ambiguous = info[5].As<Napi::Boolean>().Value();
    }
    if (info.Length() > 6 && info[6].IsArray()) {
        types = extractCompletionArray(info[6].As<Napi::Array>());
    }

    if (!entries.empty()) {
        size_t replaceStart, replaceEnd;
        if (rs < 0 || re_ < 0) {
            replaceStart = 0;
            replaceEnd = g_state.pos;
            while (replaceEnd < g_state.len &&
                   !std::isspace(static_cast<unsigned char>(g_state.buf[replaceEnd]))) {
                replaceEnd++;
            }
        } else {
            replaceStart = std::min(static_cast<size_t>(rs), g_state.len);
            replaceEnd = std::min(static_cast<size_t>(re_), g_state.len);
            if (replaceEnd < replaceStart) replaceEnd = replaceStart;
        }
        g_state.completion_start = replaceStart;
        g_state.completion_end = replaceEnd;
        g_state.completion_pre = std::string(g_state.buf, replaceStart);
        g_state.completion_tail = std::string(g_state.buf + replaceEnd, g_state.len - replaceEnd);
        // Single-match auto-space logic, parallel to the sync path.
        if (entries.size() == 1) {
            std::string e = std::move(entries[0]);
            bool endsSlash = !e.empty() && e.back() == '/';
            bool tailHasSpace = !g_state.completion_tail.empty() &&
                std::isspace(static_cast<unsigned char>(g_state.completion_tail[0]));
            if (!ambiguous && !endsSlash && !tailHasSpace) e += ' ';
            spliceCompletion(&g_state, e);
            bufferChanged();
            notifyRender();
        } else if (g_menu_complete) {
            g_state.completion_original = std::string(g_state.buf, g_state.len);
            g_state.completion_entries = std::move(entries);
            g_state.completion_descriptions = std::move(descs);
            g_state.completion_displays = std::move(displays);
            g_state.completion_types = std::move(types);
            g_state.completion_idx = 0;
            g_state.menu_state = 1;
            g_state.menu_row = 0;
            g_state.menu_col = 0;
            g_state.menu_viewport_start = 0;
            menuLayout(&g_state);
            notifyRender();
        } else {
            g_state.completion_displays = std::move(displays);
            g_state.completion_types = std::move(types);
            startCompletion(&g_state, std::move(entries), std::move(descs));
        }
    }

    if (g_ctx && g_ctx->poll && g_state.active) {
        uv_poll_start(g_ctx->poll, UV_READABLE, pollCallback);
    }

    return env.Undefined();
}

static Napi::Value InsertAtCursor(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) return env.Undefined();
    std::string text = info[0].As<Napi::String>().Utf8Value();
    size_t tlen = text.size();
    if (g_state.len + tlen > g_state.buflen) return env.Undefined(); // won't fit
    // Make room at cursor position.
    if (g_state.pos < g_state.len) {
        memmove(g_state.buf + g_state.pos + tlen,
                g_state.buf + g_state.pos,
                g_state.len - g_state.pos);
    }
    memcpy(g_state.buf + g_state.pos, text.c_str(), tlen);
    g_state.pos += tlen;
    g_state.len += tlen;
    g_state.buf[g_state.len] = '\0';
    bufferChanged();
    if (g_state.active) notifyRender();
    return env.Undefined();
}

static Napi::Value GetEAGAIN(const Napi::CallbackInfo &info) {
    return Napi::Number::New(info.Env(), EAGAIN);
}

// ---- Fd utility functions (previously in linenoise.cc) ----------------------

static Napi::Value CloseFd(const Napi::CallbackInfo& info) {
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(info.Env(), "Expected number").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    close(info[0].As<Napi::Number>().Int32Value());
    return info.Env().Undefined();
}

static Napi::Value CreatePipe(const Napi::CallbackInfo& info) {
    int fds[2];
    if (pipe(fds) != 0) {
        Napi::Error::New(info.Env(), "pipe() failed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    Napi::Array result = Napi::Array::New(info.Env(), 2);
    result.Set((uint32_t)0, Napi::Number::New(info.Env(), fds[0]));
    result.Set((uint32_t)1, Napi::Number::New(info.Env(), fds[1]));
    return result;
}

static Napi::Value DupFdUtil(const Napi::CallbackInfo& info) {
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(info.Env(), "Expected number").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    int fd = dup(info[0].As<Napi::Number>().Int32Value());
    return Napi::Number::New(info.Env(), fd);
}

static Napi::Value Dup2FdUtil(const Napi::CallbackInfo& info) {
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(info.Env(), "Expected (fd, fd)").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    int result = dup2(info[0].As<Napi::Number>().Int32Value(), info[1].As<Napi::Number>().Int32Value());
    return Napi::Number::New(info.Env(), result);
}

static Napi::Value WriteFdUtil(const Napi::CallbackInfo& info) {
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
        Napi::TypeError::New(info.Env(), "Expected (fd, string)").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    int fd = info[0].As<Napi::Number>().Int32Value();
    std::string data = info[1].As<Napi::String>().Utf8Value();
    [[maybe_unused]] auto _w = write(fd, data.c_str(), data.size());
    return info.Env().Undefined();
}

// ---- Registration ----------------------------------------------------------

Napi::Object InitInputEngine(Napi::Env env, Napi::Object exports) {
    exports.Set("inputStart",         Napi::Function::New(env, InputStart));
    exports.Set("inputStop",          Napi::Function::New(env, InputStop));
    exports.Set("inputGetCols",       Napi::Function::New(env, InputGetCols));
    exports.Set("inputWriteRaw",      Napi::Function::New(env, InputWriteRaw));
    exports.Set("inputRenderLine",    Napi::Function::New(env, InputRenderLine));
    exports.Set("inputHistoryAdd",    Napi::Function::New(env, HistoryAdd));
    exports.Set("inputHistorySetMaxLen", Napi::Function::New(env, HistorySetMaxLen));
    exports.Set("inputHistorySave",   Napi::Function::New(env, HistorySave));
    exports.Set("inputHistoryLoad",   Napi::Function::New(env, HistoryLoad));
    exports.Set("inputHistoryCount",  Napi::Function::New(env, HistoryCount));
    exports.Set("inputHistoryGet",    Napi::Function::New(env, HistoryGet));
    exports.Set("inputHistoryAll",    Napi::Function::New(env, HistoryAll));
    exports.Set("inputHistorySearchPrefix", Napi::Function::New(env, HistorySearchPrefix));
    exports.Set("inputSetSuggestion", Napi::Function::New(env, SetSuggestion));
    exports.Set("inputSetInput",       Napi::Function::New(env, SetInput));
    exports.Set("inputInsertAtCursor", Napi::Function::New(env, InsertAtCursor));
    exports.Set("inputSetCompletions", Napi::Function::New(env, SetCompletions));
    exports.Set("inputSetWordChars",  Napi::Function::New(env, SetWordChars));
    exports.Set("inputSetCompletionStyle", Napi::Function::New(env, SetCompletionStyle));
    exports.Set("inputSetListColors", Napi::Function::New(env, SetListColors));
    exports.Set("inputEAGAIN",        Napi::Function::New(env, GetEAGAIN));
    // Fd utilities (previously in linenoise.cc)
    exports.Set("closeFd",            Napi::Function::New(env, CloseFd));
    exports.Set("createPipe",         Napi::Function::New(env, CreatePipe));
    exports.Set("dupFd",              Napi::Function::New(env, DupFdUtil));
    exports.Set("dup2Fd",             Napi::Function::New(env, Dup2FdUtil));
    exports.Set("writeFd",            Napi::Function::New(env, WriteFdUtil));
    return exports;
}

} // namespace jsh
