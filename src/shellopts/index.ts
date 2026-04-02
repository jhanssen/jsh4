// Shell option flags (set -e, set -u, set -x, set -o pipefail, etc.)
export const shellOpts = {
    errexit: false,   // -e: exit on error
    nounset: false,   // -u: error on unset variables
    xtrace: false,    // -x: print commands before execution
    pipefail: false,  // -o pipefail: pipeline fails if any stage fails
    allexport: false, // -a: auto-export all assigned variables
    noclobber: false, // -C: prevent > from overwriting existing files
};

export function saveShellOpts(): typeof shellOpts {
    return { ...shellOpts };
}

export function restoreShellOpts(saved: typeof shellOpts): void {
    Object.assign(shellOpts, saved);
}
