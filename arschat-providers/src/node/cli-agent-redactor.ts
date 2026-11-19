/** Retain a possible secret prefix until the next fragment, independently for each channel. */
export class CliStreamRedactor {
    private pending = '';
    private readonly secrets: string[];
    constructor(secrets: string[]) { this.secrets = secrets.filter(Boolean).sort((a, b) => b.length - a.length); }

    push(fragment: string, final = false): string {
        const input = this.pending + fragment;
        let output = '', offset = 0;
        while (offset < input.length) {
            const rest = input.slice(offset);
            if (!final && this.secrets.some(secret => secret.length > rest.length && secret.startsWith(rest))) { break; }
            const match = this.secrets.find(secret => rest.startsWith(secret));
            if (match) { output += '[REDACTED]'; offset += match.length; }
            else { output += input[offset++]; }
        }
        this.pending = input.slice(offset);
        return output;
    }
}
