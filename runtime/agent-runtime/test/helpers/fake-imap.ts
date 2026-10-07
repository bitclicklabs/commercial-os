/**
 * Minimal in-process IMAP4rev1 server (plain TCP on 127.0.0.1, random port) for the real
 * imapflow client. Supports what the read-only reader uses: CAPABILITY, LOGIN, LIST,
 * EXAMINE/SELECT, UID SEARCH (UID n:* | SINCE | ALL), UID FETCH (UID, INTERNALDATE,
 * RFC822.SIZE, BODY.PEEK[]<0.n>), UID STORE +FLAGS, NOOP, LOGOUT.
 * Every command is recorded in `commands`, so tests can assert that nothing destructive
 * (EXPUNGE, CLOSE, MOVE, COPY, DELETE, APPEND, STORE without permission) was ever sent.
 */
import net from 'node:net';

export interface FakeImapMessage {
  uid: number;
  source: string;
  internalDate?: Date;
  flags?: string[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function imapDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function parseSearchDate(s: string): Date {
  const [day, mon, year] = s.replace(/"/g, '').split('-');
  return new Date(Date.UTC(Number(year), MONTHS.indexOf(mon!), Number(day)));
}

export class FakeImapServer {
  readonly commands: string[] = [];
  messages: FakeImapMessage[] = [];
  uidValidity = 1000;
  user = 'buzon@publiexpe.test';
  password = 'secreto-de-prueba';
  private server: net.Server | null = null;
  port = 0;

  async start(): Promise<number> {
    this.server = net.createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Commands without tag, upper-cased verb (e.g. `UID FETCH 1:3 (...)`). */
  verbs(): string[] {
    return this.commands.map((c) => c.split(' ').slice(1).join(' '));
  }

  private handle(socket: net.Socket): void {
    let buffer = Buffer.alloc(0);
    let pendingLine = '';
    let literalLeft = 0;
    let selected: { readOnly: boolean } | null = null;
    const write = (s: string | Buffer) => socket.write(s);
    write('* OK [CAPABILITY IMAP4rev1] fake imap ready\r\n');

    const exec = (line: string) => {
      this.commands.push(line.replace(this.password, '***'));
      const [tag, ...rest] = line.split(' ');
      const verb = (rest[0] ?? '').toUpperCase();
      const args = rest.slice(1).join(' ');
      const ok = (msg = 'done') => write(`${tag} OK ${msg}\r\n`);
      switch (verb) {
        case 'CAPABILITY':
          write('* CAPABILITY IMAP4rev1\r\n');
          return ok();
        case 'NOOP':
          return ok();
        case 'LOGIN': {
          const parts = args.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
          const unq = (s: string | undefined) => (s ?? '').replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
          if (unq(parts[0]) === this.user && unq(parts[1]) === this.password) return ok('[CAPABILITY IMAP4rev1] logged in');
          return write(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials\r\n`);
        }
        case 'LIST':
        case 'LSUB':
          write(`* ${verb} (\\HasNoChildren) "/" INBOX\r\n`);
          return ok();
        case 'EXAMINE':
        case 'SELECT': {
          selected = { readOnly: verb === 'EXAMINE' };
          const uidNext = Math.max(0, ...this.messages.map((m) => m.uid)) + 1;
          write(`* ${this.messages.length} EXISTS\r\n* 0 RECENT\r\n`);
          write('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n');
          write(`* OK [PERMANENTFLAGS (${selected.readOnly ? '' : '\\Seen \\*'})] flags\r\n`);
          write(`* OK [UIDVALIDITY ${this.uidValidity}] uids valid\r\n* OK [UIDNEXT ${uidNext}] next\r\n`);
          return ok(selected.readOnly ? '[READ-ONLY] examined' : '[READ-WRITE] selected');
        }
        case 'UID': {
          const sub = (rest[1] ?? '').toUpperCase();
          const subArgs = rest.slice(2).join(' ');
          const sorted = [...this.messages].sort((a, b) => a.uid - b.uid);
          const maxUid = sorted.at(-1)?.uid ?? 0;
          const inSet = (set: string, uid: number) =>
            set.split(',').some((part) => {
              const [a, b] = part.split(':');
              const lo = a === '*' ? maxUid : Number(a);
              const hi = b === undefined ? lo : b === '*' ? maxUid : Number(b);
              return uid >= Math.min(lo, hi) && uid <= Math.max(lo, hi);
            });
          if (!selected) return write(`${tag} BAD no mailbox selected\r\n`);
          if (sub === 'SEARCH') {
            let hits = sorted;
            const uidRange = /UID (\S+)/i.exec(subArgs);
            const since = /SINCE (\S+)/i.exec(subArgs);
            if (uidRange) hits = hits.filter((m) => inSet(uidRange[1]!, m.uid));
            if (since) hits = hits.filter((m) => (m.internalDate ?? new Date()).getTime() >= parseSearchDate(since[1]!).getTime());
            write(`* SEARCH${hits.map((m) => ` ${m.uid}`).join('')}\r\n`);
            return ok();
          }
          if (sub === 'FETCH') {
            const set = rest[2] ?? '';
            const max = /BODY\.PEEK\[\]<0\.(\d+)>/i.exec(subArgs);
            for (const m of sorted) {
              if (!inSet(set, m.uid)) continue;
              const seq = sorted.indexOf(m) + 1;
              const full = Buffer.from(m.source.replace(/\r?\n/g, '\r\n'), 'utf8');
              const body = max ? full.subarray(0, Number(max[1])) : full;
              const key = max ? 'BODY[]<0>' : 'BODY[]';
              write(`* ${seq} FETCH (UID ${m.uid} INTERNALDATE "${imapDate(m.internalDate ?? new Date())}" RFC822.SIZE ${full.length} ${key} {${body.length}}\r\n`);
              write(body);
              write(')\r\n');
            }
            return ok();
          }
          if (sub === 'STORE') {
            if (selected.readOnly) return write(`${tag} NO mailbox is read-only\r\n`);
            const set = rest[2] ?? '';
            const flags = /\(([^)]*)\)/.exec(subArgs)?.[1]?.split(' ').filter(Boolean) ?? [];
            for (const m of sorted) {
              if (!inSet(set, m.uid)) continue;
              m.flags = [...new Set([...(m.flags ?? []), ...flags])];
              write(`* ${sorted.indexOf(m) + 1} FETCH (UID ${m.uid} FLAGS (${m.flags.join(' ')}))\r\n`);
            }
            return ok();
          }
          return write(`${tag} BAD unsupported UID ${sub}\r\n`);
        }
        case 'LOGOUT':
          write('* BYE bye\r\n');
          ok();
          socket.end();
          return;
        default:
          return write(`${tag} BAD unsupported ${verb}\r\n`);
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (literalLeft > 0) {
          if (buffer.length < literalLeft) return;
          pendingLine += buffer.subarray(0, literalLeft).toString('utf8');
          buffer = buffer.subarray(literalLeft);
          literalLeft = 0;
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.subarray(0, nl).toString('utf8');
        buffer = buffer.subarray(nl + 2);
        const lit = /\{(\d+)(\+?)\}$/.exec(line);
        if (lit) {
          pendingLine += line.slice(0, lit.index);
          literalLeft = Number(lit[1]);
          if (!lit[2]) write('+ go ahead\r\n');
          continue;
        }
        const full = pendingLine + line;
        pendingLine = '';
        exec(full);
      }
    });
    socket.on('error', () => undefined);
  }
}
