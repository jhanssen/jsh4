// Shell option flags (set -e, set -u, set -x, set -o pipefail)
export const shellOpts = {
    errexit: false,   // -e: exit on error
    nounset: false,   // -u: error on unset variables
    xtrace: false,    // -x: print commands before execution
    pipefail: false,  // -o pipefail: pipeline fails if any stage fails
};

export function saveShellOpts(): typeof shellOpts {
    return { ...shellOpts };
}

export function restoreShellOpts(saved: typeof shellOpts): void {
    Object.assign(shellOpts, saved);
}
