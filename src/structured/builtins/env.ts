// Yield process environment variables as structured rows.
//
//   @env                              all env vars, sorted by name
//   @env | @where v => v.name.startsWith("XDG_")
//   @env | @select name

export interface EnvVar {
    name: string;
    value: string;
}

export async function* env(
    _args: string[],
): AsyncGenerator<EnvVar> {
    const names = Object.keys(process.env).sort();
    for (const name of names) {
        yield { name, value: process.env[name] ?? "" };
    }
}
